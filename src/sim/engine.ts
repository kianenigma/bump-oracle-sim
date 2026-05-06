import type {
  AggregatorConfig,
  BlockMetrics,
  RealPriceSpec,
  EpsilonMode,
  EpsilonSpec,
  ResolvedPriceSource,
  SimulationConfig,
  SimulationResult,
  SimulationSummary,
  ValidatorGroup,
  ValidatorParams,
  PricePoint,
} from "../types.js";
import { mulberry32 } from "../rng.js";
import { PriceEndpoint } from "./price-endpoint.js";
import { HonestValidator, type ValidatorAgent } from "./validator.js";
import {
  MaliciousValidator,
  PushyMaliciousValidator,
  NoopValidator,
  DelayedValidator,
  DriftValidator,
} from "./malicious.js";
import { Chain } from "./chain.js";
import { makeAggregator } from "./aggregator.js";
import { maxBlockDelta } from "../data/interpolator.js";
import { BLOCK_TIME_SECONDS, DEFAULT_VALIDATOR_PARAMS } from "../config.js";
import { totalValidators } from "../validators.js";

// Constructor signature shared by every validator type. The unified ctor
// keeps engine code small — each group just instantiates `count` of one
// constructor with its own (priceSource, params).
type ValidatorCtor = new (
  index: number,
  endpoint: PriceEndpoint,
  rng: () => number,
  priceSource: ValidatorGroup["priceSource"],
  params: Required<ValidatorParams>,
) => ValidatorAgent;

const VALIDATOR_REGISTRY: Record<ValidatorGroup["type"], ValidatorCtor> = {
  honest: HonestValidator,
  malicious: MaliciousValidator,
  pushy: PushyMaliciousValidator,
  noop: NoopValidator,
  delayed: DelayedValidator,
  drift: DriftValidator,
};

export type BlockSink = (block: BlockMetrics) => void;

const DEFAULT_AGGREGATOR: AggregatorConfig = { kind: "median" };

/** Resolve a partial ValidatorParams against engine defaults. */
function resolveParams(p: ValidatorParams | undefined): Required<ValidatorParams> {
  return { ...DEFAULT_VALIDATOR_PARAMS, ...(p ?? {}) };
}

/** Resolve EpsilonSpec into a numeric value + mode. Only meaningful for nudge. */
function resolveEpsilon(
  spec: EpsilonSpec,
  pricePoints: PricePoint[],
  validatorCount: number,
  log: boolean,
): { epsilon: number; mode: EpsilonMode } {
  if (spec === "auto") {
    const maxDelta = maxBlockDelta(pricePoints);
    let eps = maxDelta / Math.max(1, validatorCount);
    if (eps === 0) eps = 0.0001;
    if (log) console.log(`  Auto epsilon: ${eps.toFixed(6)} (maxDelta=${maxDelta.toFixed(4)}, validators=${validatorCount})`);
    return { epsilon: eps, mode: "abs" };
  }
  if (typeof spec === "object" && "ratio" in spec) {
    if (log) console.log(`  Ratio epsilon: ${(spec.ratio * 100).toFixed(4)}% per bump`);
    return { epsilon: spec.ratio, mode: "ratio" };
  }
  return { epsilon: spec, mode: "abs" };
}

export function runSimulation(
  config: SimulationConfig,
  source: ResolvedPriceSource,
  sink?: BlockSink,
  quiet = false,
  onProgress?: (pct: number) => void,
): SimulationResult {
  const pricePoints = source.pricePoints;
  if (!quiet) printConfig(config, pricePoints);

  const rng = mulberry32(config.seed);
  const endpoint = new PriceEndpoint(pricePoints, source.venuePrices);

  // Validate every group's priceSource against the loaded data.
  for (const g of config.validators) {
    if (g.priceSource.kind === "random-venue" && !endpoint.hasVenues()) {
      throw new Error(
        `Validator group "${g.type}" requested priceSource=random-venue but the loaded ` +
        `data source has no per-venue prices. Use --data-source=trades.`,
      );
    }
  }

  const validatorCount = totalValidators(config.validators);
  if (validatorCount === 0) {
    throw new Error("SimulationConfig.validators is empty (or sums to 0 count).");
  }

  // Resolve aggregator + (if nudge) epsilon.
  const aggregatorCfg: AggregatorConfig = config.aggregator ?? DEFAULT_AGGREGATOR;
  const aggregator = makeAggregator(aggregatorCfg);
  let epsilon = 0;
  let epsilonMode: EpsilonMode = "abs";
  if (aggregatorCfg.kind === "nudge") {
    const resolved = resolveEpsilon(aggregatorCfg.epsilon, pricePoints, validatorCount, !quiet);
    epsilon = resolved.epsilon;
    epsilonMode = resolved.mode;
  }

  // Instantiate validators in group order. Each gets a unique index and a
  // mulberry32 derived from `seed + index + 1`.
  const validators: ValidatorAgent[] = new Array(validatorCount);
  let nextIndex = 0;
  for (const g of config.validators) {
    const Ctor = VALIDATOR_REGISTRY[g.type];
    const params = resolveParams(g.params);
    for (let i = 0; i < g.count; i++) {
      validators[nextIndex] = new Ctor(
        nextIndex,
        endpoint,
        mulberry32(config.seed + nextIndex + 1),
        g.priceSource,
        params,
      );
      nextIndex++;
    }
  }

  const initialPrice = pricePoints[0].price;
  const chain = new Chain(initialPrice, epsilon, epsilonMode, validators, endpoint, rng, aggregator);

  // Run simulation with incremental summary computation.
  const totalBlocks = endpoint.totalBlocks;
  const convergenceThreshold = config.convergenceThreshold;

  let sumDev = 0;
  let sumDevPct = 0;
  let maxDev = 0;
  let maxDevPct = 0;
  let converged = 0;
  let deviationIntegral = 0;
  let maxDeviationRate = 0;
  let consecAbove = 0;
  let maxConsecAbove = 0;
  const allDeviationPcts = new Float64Array(totalBlocks);
  let prevBlock: BlockMetrics | null = null;

  if (!quiet) {
    const groupParts = config.validators
      .filter(g => g.count > 0)
      .map(g => `${g.count} ${g.type}`);
    console.log(`  Running ${totalBlocks.toLocaleString()} blocks (${groupParts.join(", ")})...`);
  }

  const progressInterval = Math.max(1, Math.floor(totalBlocks / 100));
  for (let i = 0; i < totalBlocks; i++) {
    const m = chain.nextBlock();

    if (prevBlock !== null) {
      const devEnd = m.realPrice !== 0
        ? (Math.abs(m.realPrice - prevBlock.oraclePrice) / m.realPrice) * 100
        : 0;
      deviationIntegral += (prevBlock.deviationPct + devEnd) / 2 * BLOCK_TIME_SECONDS;
      const rate = Math.abs(m.deviationPct - prevBlock.deviationPct) / BLOCK_TIME_SECONDS;
      if (rate > maxDeviationRate) maxDeviationRate = rate;
    }

    sumDev += m.deviation;
    sumDevPct += m.deviationPct;
    if (m.deviation > maxDev) maxDev = m.deviation;
    if (m.deviationPct > maxDevPct) maxDevPct = m.deviationPct;
    if (m.deviationPct < convergenceThreshold) {
      converged++;
      consecAbove = 0;
    } else {
      consecAbove++;
      if (consecAbove > maxConsecAbove) maxConsecAbove = consecAbove;
    }

    allDeviationPcts[i] = m.deviationPct;
    if (sink) sink(m);
    prevBlock = m;

    if ((i + 1) % progressInterval === 0) {
      const pct = (i + 1) / totalBlocks * 100;
      if (!quiet) process.stdout.write(`\r  Progress: ${pct.toFixed(0)}% (${(i + 1).toLocaleString()} / ${totalBlocks.toLocaleString()})`);
      if (onProgress) onProgress(pct);
    }
  }
  if (!quiet) process.stdout.write(`\r  Progress: 100%${" ".repeat(40)}\n`);

  if (prevBlock !== null) {
    deviationIntegral += prevBlock.deviationPct * BLOCK_TIME_SECONDS;
  }

  const summary: SimulationSummary = {
    totalBlocks,
    aggregator: aggregatorCfg.kind,
    meanDeviation: sumDev / totalBlocks,
    maxDeviation: maxDev,
    meanDeviationPct: sumDevPct / totalBlocks,
    maxDeviationPct: maxDevPct,
    epsilon,
    epsilonMode,
    convergenceRate: converged / totalBlocks,
    convergenceThreshold,
    deviationIntegral,
    maxDeviationRate,
    maxConsecutiveBlocksAboveThreshold: maxConsecAbove,
    p95DeviationPct: percentile(allDeviationPcts, 0.95),
    p99DeviationPct: percentile(allDeviationPcts, 0.99),
  };

  if (!quiet) {
    console.log(`  Done. Mean deviation: ${summary.meanDeviationPct.toFixed(4)}%, max: ${summary.maxDeviationPct.toFixed(4)}%`);
    console.log(`  Convergence rate (<${summary.convergenceThreshold}% deviation): ${(summary.convergenceRate * 100).toFixed(1)}%`);
    console.log(`  Deviation integral: ${summary.deviationIntegral.toFixed(2)} %-seconds`);
    console.log(`  Max deviation rate: ${summary.maxDeviationRate.toFixed(6)} %/s`);
  }

  // Persist the resolved aggregator (concrete numeric epsilon) so .simdata
  // and the UI never have to re-resolve "auto".
  const resolvedAggregator: AggregatorConfig = aggregatorCfg.kind === "nudge"
    ? { kind: "nudge", epsilon: epsilonMode === "ratio" ? { ratio: epsilon } : epsilon }
    : aggregatorCfg;

  return { config: { ...config, aggregator: resolvedAggregator }, summary };
}

/** Print a structured snapshot of the run config. Greppable, one block per sim. */
function printConfig(config: SimulationConfig, pricePoints?: PricePoint[]): void {
  const agg = config.aggregator ?? DEFAULT_AGGREGATOR;
  const aggStr = (agg.kind === "median" || agg.kind === "mean") && agg.k && agg.k > 0
    ? `${agg.kind}(k=${agg.k})`
    : agg.kind;

  // Build a one-liner mix string from the validators array.
  const total = totalValidators(config.validators);
  const parts: string[] = [];
  let honest = 0;
  for (const g of config.validators) {
    if (g.type === "honest") honest += g.count;
    else if (g.count > 0) parts.push(`${((g.count / total) * 100).toFixed(1)}% ${g.type}`);
  }
  const honestPct = ((honest / total) * 100).toFixed(1);
  const mixStr = `${honestPct}% honest` + (parts.length ? ", " + parts.join(", ") : "");

  // Epsilon string only printed for nudge.
  let epsStr = "—";
  if (agg.kind === "nudge") {
    if (agg.epsilon === "auto") epsStr = "auto";
    else if (typeof agg.epsilon === "object" && "ratio" in agg.epsilon) epsStr = `ratio=${(agg.epsilon.ratio * 100).toFixed(4)}%/bump`;
    else epsStr = agg.epsilon.toString();
  }

  // Surface the param knobs of the malicious types actually present.
  const presentTypes = new Set(config.validators.filter(g => g.count > 0).map(g => g.type));
  const malParts: string[] = [];
  for (const g of config.validators) {
    if (g.count === 0) continue;
    const p = resolveParams(g.params);
    if (g.type === "delayed") malParts.push(`delayBlocks=${p.delayBlocks}`);
    if (g.type === "pushy")   malParts.push(`pushyQuoteBias=${(p.pushyQuoteBias * 100).toFixed(2)}%`);
    if (g.type === "drift")   malParts.push(`driftQuoteStep=${(p.driftQuoteStep * 100).toFixed(3)}%`);
  }

  const rp: RealPriceSpec = config.realPrice ?? { kind: "candles" };
  const rpStr = rp.kind === "candles"
    ? "candles (Binance US 1m → interp 6s)"
    : `trades (${rp.venues.join(", ")}, cross-venue=${rp.crossVenue?.kind ?? "mean"})`;

  // Distinct priceSource kinds across groups (usually just one).
  const psKinds = new Set(config.validators.map(g => g.priceSource.kind));
  const psStr = psKinds.size === 1 ? [...psKinds][0] : [...psKinds].join("/");
  const jitters = new Set(config.validators.map(g => g.priceSource.jitterStdDev));
  const jitterStr = jitters.size === 1
    ? `${([...jitters][0] * 100).toFixed(3)}%`
    : [...jitters].map(j => `${(j * 100).toFixed(3)}%`).join("/");

  console.log(`\n  ┌─ ${config.label}`);
  console.log(`  │  real price   : ${rpStr}`);
  console.log(`  │  validator obs: ${psStr}`);
  console.log(`  │  aggregator   : ${aggStr}`);
  console.log(`  │  range        : ${config.startDate} → ${config.endDate}`);
  console.log(`  │  validators   : ${total} (${mixStr})`);
  console.log(`  │  epsilon      : ${epsStr}${agg.kind !== "nudge" ? "  (n/a)" : ""}`);
  if (rp.kind === "trades" && pricePoints && pricePoints.length > 1) {
    const md = maxBlockDelta(pricePoints);
    const autoEps = md / total;
    console.log(`  │  trade-mode ε : maxBlockDelta=${md.toFixed(6)}, auto-ε ≈ ${autoEps.toFixed(6)} (validators=${total})`);
  }
  console.log(`  │  jitter stddev: ${jitterStr}`);
  if (malParts.length > 0) console.log(`  │  malicious    : ${malParts.join(", ")}`);
  console.log(`  │  seed         : ${config.seed}`);
  console.log(`  └─ convergence  : <${config.convergenceThreshold}% deviation`);
  // Avoid an unused-var warning for presentTypes when no malicious knobs are present.
  void presentTypes;
}

function percentile(arr: Float64Array, p: number): number {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort();
  const idx = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
  return sorted[idx];
}

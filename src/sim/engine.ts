import type { SimulationConfig, SimulationResult, BlockMetrics, SimulationSummary, PricePoint, EpsilonMode, AggregatorConfig, MaliciousParams, ResolvedPriceSource, ValidatorPriceSource } from "../types.js";
import { mixFraction, mixJitter } from "../mix.js";
import { mulberry32 } from "../rng.js";
import { PriceEndpoint } from "./price-endpoint.js";
import { HonestValidator, type ValidatorAgent } from "./validator.js";
import { MaliciousValidator, PushyMaliciousValidator, NoopValidator, DelayedValidator, DriftValidator } from "./malicious.js";
import { Chain } from "./chain.js";
import { makeAggregator } from "./aggregator.js";
import { maxBlockDelta } from "../data/interpolator.js";
import { BLOCK_TIME_SECONDS, DEFAULT_MALICIOUS_PARAMS } from "../config.js";

// Registry of validator constructors keyed by name.
// Every entry must have the same constructor signature as HonestValidator.
type ValidatorCtor = new (
  index: number,
  endpoint: PriceEndpoint,
  rng: () => number,
  jitterStdDev: number,
  params: MaliciousParams,
  priceSource: ValidatorPriceSource,
) => ValidatorAgent;

const VALIDATOR_REGISTRY: Record<string, ValidatorCtor> = {
  malicious: MaliciousValidator,
  pushy: PushyMaliciousValidator,
  noop: NoopValidator,
  delayed: DelayedValidator,
  drift: DriftValidator,
};

// Callback invoked for each block during simulation. Return value is ignored.
export type BlockSink = (block: BlockMetrics) => void;

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

  // Validate that requested validator-price-source mode is compatible with
  // the loaded data source. random-venue requires per-venue series.
  const validatorPriceSource: ValidatorPriceSource = config.validatorPriceSource ?? { kind: "median" };
  if (validatorPriceSource.kind === "random-venue" && !endpoint.hasVenues()) {
    throw new Error(
      `validatorPriceSource="random-venue" requires --data-source=trades; ` +
      `current run has no per-venue prices loaded.`,
    );
  }

  // Resolve epsilon spec into a numeric value + mode
  let epsilon: number;
  let epsilonMode: EpsilonMode;
  if (config.epsilon === "auto") {
    const maxDelta = maxBlockDelta(pricePoints);
    epsilon = maxDelta / config.validatorCount;
    if (epsilon === 0) epsilon = 0.0001; // safety floor
    epsilonMode = "abs";
    if (!quiet) console.log(`  Auto epsilon: ${epsilon.toFixed(6)} (maxDelta=${maxDelta.toFixed(4)}, validators=${config.validatorCount})`);
  } else if (typeof config.epsilon === "object" && "ratio" in config.epsilon) {
    epsilon = config.epsilon.ratio;
    epsilonMode = "ratio";
    if (!quiet) console.log(`  Ratio epsilon: ${(epsilon * 100).toFixed(4)}% per bump`);
  } else {
    epsilon = config.epsilon;
    epsilonMode = "abs";
  }

  // Create validators from mix
  const validators: ValidatorAgent[] = [];
  const mix = config.validatorMix;

  // Calculate counts for each non-honest type
  const typeCounts: { name: string; count: number; ctor: ValidatorCtor; jitter: number }[] = [];
  let nonHonestTotal = 0;
  for (const [name, entry] of Object.entries(mix)) {
    if (name === "honest") continue; // honest entry is jitter-only, not a type
    const ctor = VALIDATOR_REGISTRY[name];
    if (!ctor) {
      throw new Error(`Unknown validator type "${name}". Available: ${Object.keys(VALIDATOR_REGISTRY).join(", ")}`);
    }
    const fraction = mixFraction(entry);
    const count = Math.floor(config.validatorCount * fraction);
    typeCounts.push({ name, count, ctor, jitter: mixJitter(entry, config.jitterStdDev) });
    nonHonestTotal += count;
  }

  const honestCount = config.validatorCount - nonHonestTotal;
  if (honestCount < 0) {
    throw new Error(`Validator mix fractions sum to more than 1.0`);
  }

  // Resolve adversarial knobs (each scenario can override these in its config).
  const maliciousParams: MaliciousParams = config.maliciousParams ?? DEFAULT_MALICIOUS_PARAMS;

  let nextIndex = 0;

  // Honest validators first (use per-type jitter if "honest" key is in the mix)
  const honestJitter = mix["honest"] ? mixJitter(mix["honest"], config.jitterStdDev) : config.jitterStdDev;
  for (let i = 0; i < honestCount; i++) {
    validators.push(new HonestValidator(nextIndex, endpoint, mulberry32(config.seed + nextIndex + 1), honestJitter, maliciousParams, validatorPriceSource));
    nextIndex++;
  }

  // Non-honest types (each with its own jitter)
  for (const { name, count, ctor, jitter } of typeCounts) {
    for (let i = 0; i < count; i++) {
      validators.push(new ctor(nextIndex, endpoint, mulberry32(config.seed + nextIndex + 1), jitter, maliciousParams, validatorPriceSource));
      nextIndex++;
    }
  }

  // Build description for logging
  const parts = [`${honestCount} honest`];
  for (const { name, count } of typeCounts) {
    if (count > 0) parts.push(`${count} ${name}`);
  }

  // Resolve aggregator (defaults to nudge for back-compat)
  const aggregatorCfg: AggregatorConfig = config.aggregator ?? { kind: "nudge" };
  const aggregator = makeAggregator(aggregatorCfg);

  // Initialize chain
  const initialPrice = pricePoints[0].price;
  const chain = new Chain(initialPrice, epsilon, epsilonMode, validators, endpoint, rng, aggregator);

  // Run simulation with incremental summary computation
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

  if (!quiet) console.log(`  Running ${totalBlocks.toLocaleString()} blocks (${parts.join(", ")})...`);

  const progressInterval = Math.max(1, Math.floor(totalBlocks / 100));
  for (let i = 0; i < totalBlocks; i++) {
    const m = chain.nextBlock();

    // Incremental summary: finalize the *previous* block's trapezoidal integral
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

  // Last block's integral contribution (no next block)
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

  const resolvedEpsilon = epsilonMode === "ratio" ? { ratio: epsilon } : epsilon;
  return { config: { ...config, epsilon: resolvedEpsilon }, summary };
}

/** Print a structured snapshot of the run config so each simulation start is greppable. */
function printConfig(config: SimulationConfig, pricePoints?: PricePoint[]): void {
  const agg = config.aggregator ?? { kind: "nudge" };
  const aggStr = agg.kind === "trimmed-mean" ? `trimmed-mean(k=${agg.k})` : agg.kind;
  const mixEntries = Object.entries(config.validatorMix);
  const mixStr = mixEntries.length === 0
    ? "100% honest"
    : mixEntries.map(([k, v]) => {
        const frac = typeof v === "number" ? v : (v.fraction ?? 0);
        return `${k}=${(frac * 100).toFixed(1)}%`;
      }).join(", ");
  let epsStr: string;
  if (config.epsilon === "auto") epsStr = "auto";
  else if (typeof config.epsilon === "object" && "ratio" in config.epsilon) epsStr = `ratio=${(config.epsilon.ratio * 100).toFixed(4)}%/bump`;
  else epsStr = config.epsilon.toString();

  const mp = config.maliciousParams ?? DEFAULT_MALICIOUS_PARAMS;
  // Mention only the params whose validator types are present in the mix —
  // otherwise the printout balloons with irrelevant knobs.
  const present = new Set(Object.keys(config.validatorMix));
  const malParts: string[] = [];
  if (present.has("delayed")) malParts.push(`delayBlocks=${mp.delayBlocks}`);
  if (present.has("pushy"))   malParts.push(`pushyQuoteBias=${(mp.pushyQuoteBias * 100).toFixed(2)}%`);
  if (present.has("drift"))   malParts.push(`driftQuoteStep=${(mp.driftQuoteStep * 100).toFixed(3)}%`);

  const ds = config.dataSource ?? { kind: "candles" } as const;
  const dsStr = ds.kind === "candles"
    ? "candles (Binance US 1m → interp 6s)"
    : `trades (${ds.venues.join(", ")}, cross-venue=${ds.crossVenue?.kind ?? "median"})  ⚠ intra-minute volatility preserved`;
  const vps = config.validatorPriceSource ?? { kind: "median" };

  console.log(`\n  ┌─ ${config.label}`);
  console.log(`  │  data source  : ${dsStr}`);
  console.log(`  │  validator obs: ${vps.kind === "random-venue" ? "random-venue (each query picks a random venue)" : "cross-venue median (or candle real price)"}`);
  console.log(`  │  aggregator   : ${aggStr}`);
  console.log(`  │  range        : ${config.startDate} → ${config.endDate}`);
  console.log(`  │  validators   : ${config.validatorCount} (${mixStr})`);
  console.log(`  │  epsilon      : ${epsStr}${agg.kind !== "nudge" ? "  (ignored by this aggregator)" : ""}`);
  if (ds.kind === "trades" && pricePoints && pricePoints.length > 1) {
    const md = maxBlockDelta(pricePoints);
    const autoEps = md / config.validatorCount;
    console.log(`  │  trade-mode ε : maxBlockDelta=${md.toFixed(6)}, auto-ε ≈ ${autoEps.toFixed(6)} (validators=${config.validatorCount})`);
  }
  console.log(`  │  jitter stddev: ${(config.jitterStdDev * 100).toFixed(3)}%`);
  if (malParts.length > 0) console.log(`  │  malicious    : ${malParts.join(", ")}`);
  console.log(`  │  seed         : ${config.seed}`);
  console.log(`  └─ convergence  : <${config.convergenceThreshold}% deviation`);
}

/** Compute the p-th percentile (0-1) of a Float64Array by sorting a copy. */
function percentile(arr: Float64Array, p: number): number {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort();
  const idx = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
  return sorted[idx];
}

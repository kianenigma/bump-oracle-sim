import type { SimulationConfig, SimulationResult, BlockMetrics, SimulationSummary, PricePoint } from "../types.js";
import { mixFraction, mixJitter } from "../mix.js";
import { mulberry32 } from "../rng.js";
import { PriceEndpoint } from "./price-endpoint.js";
import { HonestValidator, type ValidatorAgent } from "./validator.js";
import { MaliciousValidator, PushyMaliciousValidator, NoopValidator, DelayedValidator, DriftValidator } from "./malicious.js";
import { Chain } from "./chain.js";
import { maxBlockDelta } from "../data/interpolator.js";
import { BLOCK_TIME_SECONDS } from "../config.js";

// Registry of validator constructors keyed by name.
// Every entry must have the same constructor signature as HonestValidator.
type ValidatorCtor = new (index: number, endpoint: PriceEndpoint, rng: () => number, jitterStdDev: number) => ValidatorAgent;

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
  pricePoints: PricePoint[],
  sink?: BlockSink,
  quiet = false,
  onProgress?: (pct: number) => void,
): SimulationResult {
  const rng = mulberry32(config.seed);
  const endpoint = new PriceEndpoint(pricePoints);

  // Calculate epsilon
  let epsilon: number;
  if (config.epsilon === "auto") {
    const maxDelta = maxBlockDelta(pricePoints);
    epsilon = maxDelta / config.validatorCount;
    if (epsilon === 0) epsilon = 0.0001; // safety floor
    if (!quiet) console.log(`  Auto epsilon: ${epsilon.toFixed(6)} (maxDelta=${maxDelta.toFixed(4)}, validators=${config.validatorCount})`);
  } else {
    epsilon = config.epsilon;
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

  let nextIndex = 0;

  // Honest validators first (use per-type jitter if "honest" key is in the mix)
  const honestJitter = mix["honest"] ? mixJitter(mix["honest"], config.jitterStdDev) : config.jitterStdDev;
  for (let i = 0; i < honestCount; i++) {
    validators.push(new HonestValidator(nextIndex, endpoint, mulberry32(config.seed + nextIndex + 1), honestJitter));
    nextIndex++;
  }

  // Non-honest types (each with its own jitter)
  for (const { name, count, ctor, jitter } of typeCounts) {
    for (let i = 0; i < count; i++) {
      validators.push(new ctor(nextIndex, endpoint, mulberry32(config.seed + nextIndex + 1), jitter));
      nextIndex++;
    }
  }

  // Build description for logging
  const parts = [`${honestCount} honest`];
  for (const { name, count } of typeCounts) {
    if (count > 0) parts.push(`${count} ${name}`);
  }

  // Initialize chain
  const initialPrice = pricePoints[0].price;
  const chain = new Chain(initialPrice, epsilon, validators, endpoint, rng);

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
    if (m.deviationPct < convergenceThreshold) converged++;

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
    meanDeviation: sumDev / totalBlocks,
    maxDeviation: maxDev,
    meanDeviationPct: sumDevPct / totalBlocks,
    maxDeviationPct: maxDevPct,
    epsilon,
    convergenceRate: converged / totalBlocks,
    convergenceThreshold,
    deviationIntegral,
    maxDeviationRate,
  };

  if (!quiet) {
    console.log(`  Done. Mean deviation: ${summary.meanDeviationPct.toFixed(4)}%, max: ${summary.maxDeviationPct.toFixed(4)}%`);
    console.log(`  Convergence rate (<${summary.convergenceThreshold}% deviation): ${(summary.convergenceRate * 100).toFixed(1)}%`);
    console.log(`  Deviation integral: ${summary.deviationIntegral.toFixed(2)} %-seconds`);
    console.log(`  Max deviation rate: ${summary.maxDeviationRate.toFixed(6)} %/s`);
  }

  return { config: { ...config, epsilon }, summary };
}

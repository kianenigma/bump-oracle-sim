import type { SimulationConfig, SimulationResult, BlockMetrics, SimulationSummary, PricePoint, ValidatorMix } from "../types.js";
import { mulberry32 } from "../rng.js";
import { PriceEndpoint } from "./price-endpoint.js";
import { HonestValidator, type ValidatorAgent } from "./validator.js";
import { MaliciousValidator, PushyMaliciousValidator } from "./malicious.js";
import { Chain } from "./chain.js";
import { maxBlockDelta } from "../data/interpolator.js";
import { BLOCK_TIME_SECONDS } from "../config.js";

// Registry of validator constructors keyed by name.
// Every entry must have the same constructor signature as HonestValidator.
type ValidatorCtor = new (index: number, endpoint: PriceEndpoint, rng: () => number, jitterStdDev: number) => ValidatorAgent;

const VALIDATOR_REGISTRY: Record<string, ValidatorCtor> = {
  malicious: MaliciousValidator,
  pushy: PushyMaliciousValidator,
};

export function runSimulation(config: SimulationConfig, pricePoints: PricePoint[]): SimulationResult {
  const rng = mulberry32(config.seed);
  const endpoint = new PriceEndpoint(pricePoints);

  // Calculate epsilon
  let epsilon: number;
  if (config.epsilon === "auto") {
    const maxDelta = maxBlockDelta(pricePoints);
    epsilon = maxDelta / config.validatorCount;
    if (epsilon === 0) epsilon = 0.0001; // safety floor
    console.log(`  Auto epsilon: ${epsilon.toFixed(6)} (maxDelta=${maxDelta.toFixed(4)}, validators=${config.validatorCount})`);
  } else {
    epsilon = config.epsilon;
  }

  // Create validators from mix
  const validators: ValidatorAgent[] = [];
  const mix = config.validatorMix;

  // Calculate counts for each non-honest type
  const typeCounts: { name: string; count: number; ctor: ValidatorCtor }[] = [];
  let nonHonestTotal = 0;
  for (const [name, fraction] of Object.entries(mix)) {
    const ctor = VALIDATOR_REGISTRY[name];
    if (!ctor) {
      throw new Error(`Unknown validator type "${name}". Available: ${Object.keys(VALIDATOR_REGISTRY).join(", ")}`);
    }
    const count = Math.floor(config.validatorCount * fraction);
    typeCounts.push({ name, count, ctor });
    nonHonestTotal += count;
  }

  const honestCount = config.validatorCount - nonHonestTotal;
  if (honestCount < 0) {
    throw new Error(`Validator mix fractions sum to more than 1.0`);
  }

  let nextIndex = 0;

  // Honest validators first
  for (let i = 0; i < honestCount; i++) {
    validators.push(new HonestValidator(nextIndex, endpoint, mulberry32(config.seed + nextIndex + 1), config.jitterStdDev));
    nextIndex++;
  }

  // Non-honest types
  for (const { name, count, ctor } of typeCounts) {
    for (let i = 0; i < count; i++) {
      validators.push(new ctor(nextIndex, endpoint, mulberry32(config.seed + nextIndex + 1), config.jitterStdDev));
      nextIndex++;
    }
  }

  // Build description for logging
  const parts = [`${honestCount} honest`];
  for (const { name, count } of typeCounts) {
    if (count > 0) parts.push(`${count} ${name}`);
  }

  // Initialize chain — author is always honest
  const initialPrice = pricePoints[0].price;
  const chain = new Chain(initialPrice, epsilon, validators, endpoint, rng);

  // Run simulation
  const totalBlocks = endpoint.totalBlocks;
  const metrics: BlockMetrics[] = [];

  console.log(`  Running ${totalBlocks} blocks (${parts.join(", ")})...`);

  for (let i = 0; i < totalBlocks; i++) {
    metrics.push(chain.nextBlock());
  }

  // Compute summary
  const summary = computeSummary(metrics, epsilon, config.convergenceThreshold);

  console.log(`  Done. Mean deviation: ${summary.meanDeviationPct.toFixed(4)}%, max: ${summary.maxDeviationPct.toFixed(4)}%`);
  console.log(`  Convergence rate (<${summary.convergenceThreshold}% deviation): ${(summary.convergenceRate * 100).toFixed(1)}%`);
  console.log(`  Deviation integral: ${summary.deviationIntegral.toFixed(2)} %-seconds`);
  console.log(`  Max deviation rate: ${summary.maxDeviationRate.toFixed(6)} %/s`);

  return { config: { ...config, epsilon }, metrics, summary };
}

function computeSummary(metrics: BlockMetrics[], epsilon: number, convergenceThreshold: number): SimulationSummary {
  let sumDev = 0;
  let sumDevPct = 0;
  let maxDev = 0;
  let maxDevPct = 0;
  let converged = 0;
  let deviationIntegral = 0;
  let maxDeviationRate = 0;

  for (let i = 0; i < metrics.length; i++) {
    const m = metrics[i];
    sumDev += m.deviation;
    sumDevPct += m.deviationPct;
    if (m.deviation > maxDev) maxDev = m.deviation;
    if (m.deviationPct > maxDevPct) maxDevPct = m.deviationPct;
    if (m.deviationPct < convergenceThreshold) converged++;

    if (i < metrics.length - 1) {
      const nextReal = metrics[i + 1].realPrice;
      const devEnd = nextReal !== 0 ? (Math.abs(nextReal - m.oraclePrice) / nextReal) * 100 : 0;

      // Trapezoidal integral: oracle price fixed at oraclePrice[i], real price
      // drifts linearly to realPrice[i+1]. Average of devStart and devEnd * dt.
      deviationIntegral += (m.deviationPct + devEnd) / 2 * BLOCK_TIME_SECONDS;

      // Max deviation rate: d(deviationPct)/dt between consecutive blocks (%/s)
      const rate = Math.abs(metrics[i + 1].deviationPct - m.deviationPct) / BLOCK_TIME_SECONDS;
      if (rate > maxDeviationRate) maxDeviationRate = rate;
    } else {
      deviationIntegral += m.deviationPct * BLOCK_TIME_SECONDS;
    }
  }

  return {
    totalBlocks: metrics.length,
    meanDeviation: sumDev / metrics.length,
    maxDeviation: maxDev,
    meanDeviationPct: sumDevPct / metrics.length,
    maxDeviationPct: maxDevPct,
    epsilon,
    convergenceRate: converged / metrics.length,
    convergenceThreshold,
    deviationIntegral,
    maxDeviationRate,
  };
}

import type { SimulationConfig, SimulationResult, BlockMetrics, SimulationSummary, PricePoint } from "../types.js";
import { mulberry32 } from "../rng.js";
import { PriceEndpoint } from "./price-endpoint.js";
import { HonestValidator, type ValidatorAgent } from "./validator.js";
import { MaliciousValidator } from "./malicious.js";
import { Chain } from "./chain.js";
import { maxBlockDelta } from "../data/interpolator.js";
import { BLOCK_TIME_SECONDS } from "../config.js";

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

  // Create validators
  const maliciousCount = Math.floor(config.validatorCount * config.maliciousFraction);
  const honestCount = config.validatorCount - maliciousCount;
  const validators: ValidatorAgent[] = [];

  for (let i = 0; i < honestCount; i++) {
    validators.push(new HonestValidator(i, endpoint, mulberry32(config.seed + i + 1), config.jitterStdDev));
  }
  for (let i = 0; i < maliciousCount; i++) {
    validators.push(
      new MaliciousValidator(honestCount + i, endpoint, mulberry32(config.seed + honestCount + i + 1), config.jitterStdDev)
    );
  }

  // Initialize chain at the first real price
  const initialPrice = pricePoints[0].price;
  const chain = new Chain(initialPrice, epsilon, validators, endpoint, rng, config.authorAlwaysHonest);

  // Run simulation
  const totalBlocks = endpoint.totalBlocks;
  const metrics: BlockMetrics[] = [];

  console.log(`  Running ${totalBlocks} blocks (${honestCount} honest, ${maliciousCount} malicious)...`);

  for (let i = 0; i < totalBlocks; i++) {
    metrics.push(chain.nextBlock());
  }

  // Compute summary
  const summary = computeSummary(metrics, epsilon, config.convergenceThreshold);

  console.log(`  Done. Mean deviation: ${summary.meanDeviationPct.toFixed(4)}%, max: ${summary.maxDeviationPct.toFixed(4)}%`);
  console.log(`  Convergence rate (<${summary.convergenceThreshold}% deviation): ${(summary.convergenceRate * 100).toFixed(1)}%`);
  console.log(`  Deviation integral: ${summary.deviationIntegral.toFixed(2)} %-seconds`);

  return { config: { ...config, epsilon }, metrics, summary };
}

function computeSummary(metrics: BlockMetrics[], epsilon: number, convergenceThreshold: number): SimulationSummary {
  let sumDev = 0;
  let sumDevPct = 0;
  let maxDev = 0;
  let maxDevPct = 0;
  let converged = 0;
  let deviationIntegral = 0;

  for (let i = 0; i < metrics.length; i++) {
    const m = metrics[i];
    sumDev += m.deviation;
    sumDevPct += m.deviationPct;
    if (m.deviation > maxDev) maxDev = m.deviation;
    if (m.deviationPct > maxDevPct) maxDevPct = m.deviationPct;
    if (m.deviationPct < convergenceThreshold) converged++;

    // Trapezoidal integral: between block i and i+1, the oracle price is fixed at
    // oraclePrice[i] while the real price drifts linearly to realPrice[i+1].
    // devStart = deviationPct[i] (already computed), devEnd = |realPrice[i+1] - oraclePrice[i]| / realPrice[i+1] * 100.
    // Integrate the trapezoid: (devStart + devEnd) / 2 * dt.
    // For the last block, fall back to a simple rectangle.
    if (i < metrics.length - 1) {
      const nextReal = metrics[i + 1].realPrice;
      const devEnd = nextReal !== 0 ? (Math.abs(nextReal - m.oraclePrice) / nextReal) * 100 : 0;
      deviationIntegral += (m.deviationPct + devEnd) / 2 * BLOCK_TIME_SECONDS;
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
  };
}

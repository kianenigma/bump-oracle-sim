import type { SimulationSummary, SimulationResult } from "../types.js";
import { BLOCK_TIME_SECONDS } from "../config.js";
import { isBaselineMix, hasAdversaryAtFraction } from "../mix.js";

export interface ResearchCriteria {
  // Weights (0-1). Higher = more important in the composite score.
  weightConvergence: number;
  weightMeanDeviation: number;
  weightMaxDeviation: number;
  weightIntegral: number;
  weightRecovery: number;
  weightP95: number;
  weightP99: number;
  weightResilience: number;

  // Hard thresholds
  maxAcceptableDeviation: number; // reject epsilon if maxDev% exceeds this (e.g. 5.0)
  convergenceThreshold: number; // what % counts as "converged"
}

export const DEFAULT_CRITERIA: ResearchCriteria = {
  // We highly prefer the episolon of choice to NEVER cause, even for a short amount of time, for
  // the price to diverge too much from the truth.
  weightMaxDeviation: 0.8,
  // We define the price as "converged" if it is less than 0.1% diverged from the true price. This
  // is a measure of "in what percentage of the time the price is less than 0.1% diverged from the
  // true price". We give it a moderate weight of 0.3
  convergenceThreshold: 0.1,
  weightConvergence: 0.3,
  // The average (mean) of the entire deviation. While important, I am not super sure if it is a
  // better metric than the deviation integral, so we give it a small weight for now.
  weightMeanDeviation: 0.1,
  // The integral of the deviation over time.
  // We give it a moderate weight of 0.3
  weightIntegral: 0.3,
  // How quickly the oracle recovers after a deviation spike.
  // Penalizes long consecutive streaks above the convergence threshold.
  weightRecovery: 0.2,
  // 95th and 99th percentile of deviation — more robust than max, less noisy than mean.
  weightP95: 0.2,
  weightP99: 0.3,
  // This is a measure of "how much the system is able to resist adversarial mixes".
  // Since our scenario is running with 33% malicious validators, we expect the system to behave good with this degree of maliciousness.
  weightResilience: 0.5,
  /// If the price was at any point 10% away, then we reject this epislon (score will become 0)
  maxAcceptableDeviation: 10,
};

export interface EpsilonScore {
  epsilon: number;
  multiplier: number;
  baselineScore: number;
  worstScore33: number;
  resilienceGap: number;
  compositeScore: number;
}

/**
 * Load criteria from defaults, overriding from environment variables if present.
 */
export function loadCriteria(): ResearchCriteria {
  const c = { ...DEFAULT_CRITERIA };

  const env = (key: string): number | undefined => {
    const val = process.env[key];
    if (val === undefined || val === "") return undefined;
    const n = parseFloat(val);
    return isNaN(n) ? undefined : n;
  };

  c.weightConvergence = env("WEIGHT_CONVERGENCE") ?? c.weightConvergence;
  c.weightMeanDeviation = env("WEIGHT_MEAN_DEVIATION") ?? c.weightMeanDeviation;
  c.weightMaxDeviation = env("WEIGHT_MAX_DEVIATION") ?? c.weightMaxDeviation;
  c.weightIntegral = env("WEIGHT_INTEGRAL") ?? c.weightIntegral;
  c.weightRecovery = env("WEIGHT_RECOVERY") ?? c.weightRecovery;
  c.weightP95 = env("WEIGHT_P95") ?? c.weightP95;
  c.weightP99 = env("WEIGHT_P99") ?? c.weightP99;
  c.weightResilience = env("WEIGHT_RESILIENCE") ?? c.weightResilience;
  c.maxAcceptableDeviation = env("MAX_ACCEPTABLE_DEVIATION") ?? c.maxAcceptableDeviation;
  c.convergenceThreshold = env("CONVERGENCE_THRESHOLD") ?? c.convergenceThreshold;

  return c;
}

/**
 * Score a single simulation result on a 0-1 scale.
 * Returns 0 (hard reject) if maxDeviationPct exceeds the acceptable limit.
 */
export function scoreSimulation(summary: SimulationSummary, criteria: ResearchCriteria): number {
  // Hard reject
  if (summary.maxDeviationPct > criteria.maxAcceptableDeviation) return 0;

  const maxDev = criteria.maxAcceptableDeviation;

  // Normalize each metric to [0, 1] where 1 = best
  const convergence = summary.convergenceRate; // already 0-1
  const meanDev = 1 - clamp(summary.meanDeviationPct / maxDev, 0, 1);
  const maxDevScore = 1 - clamp(summary.maxDeviationPct / maxDev, 0, 1);

  // Integral normalization: totalBlocks * BLOCK_TIME * maxAcceptableDev
  const integralCeiling = summary.totalBlocks * BLOCK_TIME_SECONDS * maxDev;
  const integral = 1 - clamp(summary.deviationIntegral / integralCeiling, 0, 1);

  // Recovery: normalize consecutive blocks by total blocks (1 = never stuck, 0 = stuck entire sim)
  const recovery = 1 - clamp(summary.maxConsecutiveBlocksAboveThreshold / summary.totalBlocks, 0, 1);

  // Percentile scores: same normalization as maxDev
  const p95Score = 1 - clamp(summary.p95DeviationPct / maxDev, 0, 1);
  const p99Score = 1 - clamp(summary.p99DeviationPct / maxDev, 0, 1);

  const totalWeight =
    criteria.weightConvergence + criteria.weightMeanDeviation + criteria.weightMaxDeviation +
    criteria.weightIntegral + criteria.weightRecovery + criteria.weightP95 + criteria.weightP99;

  return (
    criteria.weightConvergence * convergence +
    criteria.weightMeanDeviation * meanDev +
    criteria.weightMaxDeviation * maxDevScore +
    criteria.weightIntegral * integral +
    criteria.weightRecovery * recovery +
    criteria.weightP95 * p95Score +
    criteria.weightP99 * p99Score
  ) / totalWeight;
}

/**
 * Score epsilon values by grouping results and computing composite scores
 * that account for resilience against adversarial mixes.
 */
export function scoreEpsilons(
  results: SimulationResult[],
  epsilonMultipliers: Map<number, number>,
  criteria: ResearchCriteria,
): EpsilonScore[] {
  // Group results by epsilon
  const byEpsilon = new Map<number, SimulationResult[]>();
  for (const r of results) {
    const eps = r.config.epsilon as number;
    if (!byEpsilon.has(eps)) byEpsilon.set(eps, []);
    byEpsilon.get(eps)!.push(r);
  }

  const scores: EpsilonScore[] = [];

  for (const [epsilon, group] of byEpsilon) {
    // Baseline: the run with no non-honest validators
    const baseline = group.find(r => isBaselineMix(r.config.validatorMix));
    const baselineScore = baseline ? scoreSimulation(baseline.summary, criteria) : 0;

    // Worst score among 33% adversarial runs
    let worstScore33 = 1;
    for (const r of group) {
      if (hasAdversaryAtFraction(r.config.validatorMix, 0.33)) {
        const s = scoreSimulation(r.summary, criteria);
        if (s < worstScore33) worstScore33 = s;
      }
    }
    if (worstScore33 === 1) worstScore33 = baselineScore; // no 33% runs found

    const resilienceGap = baselineScore - worstScore33;
    const wR = criteria.weightResilience;
    const compositeScore = (1 - wR) * baselineScore + wR * (1 - clamp(resilienceGap, 0, 1));

    scores.push({
      epsilon,
      multiplier: epsilonMultipliers.get(epsilon) ?? 0,
      baselineScore,
      worstScore33,
      resilienceGap,
      compositeScore,
    });
  }

  // Sort descending by composite score
  scores.sort((a, b) => b.compositeScore - a.compositeScore);
  return scores;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

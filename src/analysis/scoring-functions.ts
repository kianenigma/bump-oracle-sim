import type { SimulationSummary } from "../types.js";
import { BLOCK_TIME_SECONDS } from "../config.js";

/** A scoring function maps a SimulationSummary to a scalar in [0, 1] where
 *  **higher = better tracking**. Each function captures a different "what
 *  do we care about" lens — accuracy on average, worst-case tail, total
 *  error over time, etc. — so the conclusion that one aggregator dominates
 *  another can be cross-checked against multiple lenses, not just an
 *  arbitrary composite. */
export interface ScoringFunction {
  name: string;
  description: string;
  /** Returns a score in [0, 1]. Higher is better. */
  score(summary: SimulationSummary): number;
}

/** Reference deviation cap for normalising "lower deviation = higher score"
 *  measures. Anything ≥ this counts as 0; 0 deviation counts as 1. */
const REF_DEVIATION_PCT = 5.0;

const clamp01 = (x: number) => x < 0 ? 0 : x > 1 ? 1 : x;
const lowIsGood = (value: number, ceiling: number) =>
  clamp01(1 - value / ceiling);

export const SCORING_FUNCTIONS: ScoringFunction[] = [
  {
    name: "mean-deviation",
    description: "Average absolute deviation from real price. Penalises systematic tracking error.",
    score: (s) => lowIsGood(s.meanDeviationPct, REF_DEVIATION_PCT),
  },
  {
    name: "max-deviation",
    description: "Worst single-block gap to real price. Penalises catastrophic spikes.",
    score: (s) => lowIsGood(s.maxDeviationPct, REF_DEVIATION_PCT),
  },
  {
    name: "p99-tail",
    description: "99th-percentile deviation. Tail-risk lens — ignores the worst 1% of blocks.",
    score: (s) => lowIsGood(s.p99DeviationPct, REF_DEVIATION_PCT),
  },
  {
    name: "convergence-rate",
    description: "Fraction of blocks whose deviation stays within the configured convergence threshold.",
    score: (s) => clamp01(s.convergenceRate),
  },
  {
    name: "deviation-integral",
    description: "Time-integrated deviation, normalised by an upper-bound ceiling. Captures total error over the run.",
    score: (s) => {
      const ceiling = s.totalBlocks * BLOCK_TIME_SECONDS * REF_DEVIATION_PCT;
      return ceiling > 0 ? lowIsGood(s.deviationIntegral, ceiling) : 1;
    },
  },
  {
    name: "recovery-speed",
    description: "How quickly the oracle recovers — measured by the longest streak of out-of-threshold blocks.",
    score: (s) => clamp01(1 - s.maxConsecutiveBlocksAboveThreshold / Math.max(1, s.totalBlocks)),
  },
  {
    name: "composite",
    description: "Equal-weighted blend of the six lenses above. A robustness check, not the source of truth.",
    score: (s) => {
      const ceiling = s.totalBlocks * BLOCK_TIME_SECONDS * REF_DEVIATION_PCT;
      const integralScore = ceiling > 0 ? lowIsGood(s.deviationIntegral, ceiling) : 1;
      const parts = [
        lowIsGood(s.meanDeviationPct, REF_DEVIATION_PCT),
        lowIsGood(s.maxDeviationPct, REF_DEVIATION_PCT),
        lowIsGood(s.p99DeviationPct, REF_DEVIATION_PCT),
        clamp01(s.convergenceRate),
        integralScore,
        clamp01(1 - s.maxConsecutiveBlocksAboveThreshold / Math.max(1, s.totalBlocks)),
      ];
      return parts.reduce((a, b) => a + b, 0) / parts.length;
    },
  },
];

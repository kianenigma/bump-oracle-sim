import type { SimulationSummary } from "../types.js";

/** A *metric* extracts a raw scalar (percent, count, fraction, absolute) from
 *  a `SimulationSummary` so the analyzer can present numbers as-is. We
 *  deliberately don't normalise to [0,1] — that loses information once a
 *  metric saturates past the reference cap (e.g. mean deviation > 5%). The
 *  reader gets the actual value plus a `direction` flag so the analyzer can
 *  pick winners and worst-cases correctly. */
export interface Metric {
  name: string;
  description: string;
  /** Unit shown next to each value, e.g. `"%"`, `" blocks"`, `""`. */
  unit: string;
  /** Direction of "better": `"low"` if lower is better (mean dev, max dev,
   *  p99, integral, consec-blocks), `"high"` if higher is better
   *  (convergence rate). The analyzer uses this to pick winners. */
  direction: "low" | "high";
  /** Pull the raw scalar out of a SimulationSummary. */
  value(summary: SimulationSummary): number;
  /** Render a single value for the table. Default is fine for most metrics
   *  but some (e.g. integer block counts) want bespoke formatting. */
  format(value: number): string;
}

const fmtPct  = (v: number): string => `${v.toFixed(4)}%`;
const fmtFrac = (v: number): string => `${(v * 100).toFixed(2)}%`;
const fmtNum  = (v: number): string => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fmtBlks = (v: number): string => `${Math.round(v).toLocaleString()} blk`;

export const METRICS: Metric[] = [
  {
    name: "mean deviation",
    description: "Average absolute deviation from real price across the run. Penalises systematic tracking error.",
    unit: "%",
    direction: "low",
    value: (s) => s.meanDeviationPct,
    format: fmtPct,
  },
  {
    name: "max deviation",
    description: "Worst single-block gap to real price. Penalises catastrophic spikes.",
    unit: "%",
    direction: "low",
    value: (s) => s.maxDeviationPct,
    format: fmtPct,
  },
  {
    name: "p99 deviation",
    description: "99th-percentile deviation — tail-risk lens that ignores the worst 1% of blocks.",
    unit: "%",
    direction: "low",
    value: (s) => s.p99DeviationPct,
    format: fmtPct,
  },
  {
    name: "convergence rate",
    description: "Fraction of blocks whose deviation stayed within the configured convergence threshold.",
    unit: "",
    direction: "high",
    value: (s) => s.convergenceRate,
    format: fmtFrac,
  },
  {
    name: "deviation integral",
    description: "Time-integrated absolute deviation (price·seconds). Captures total tracking error over the run.",
    unit: "",
    direction: "low",
    value: (s) => s.deviationIntegral,
    format: fmtNum,
  },
  {
    name: "max consec out-of-threshold",
    description: "Longest streak of blocks whose deviation exceeded the convergence threshold. Captures recovery speed.",
    unit: "",
    direction: "low",
    value: (s) => s.maxConsecutiveBlocksAboveThreshold,
    format: fmtBlks,
  },
];

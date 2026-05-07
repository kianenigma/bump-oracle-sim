import type { SimulationResult, SimulationConfig, ValidatorType } from "../types.js";
import { VALIDATOR_METADATA } from "../validators.js";
import { METRICS, type Metric } from "./scoring-functions.js";

// ─────────────────────────────────────────────────────────────────────────────
// Two-tier evaluation framework with raw-value reporting (Option C, post-
// scoring-removal). Earlier the analyzer normalised every metric to a `[0, 1]`
// score; that saturated to 0 once a deviation exceeded the 5% reference cap
// and hid the magnitude of the failure. Now we just report the raw value of
// each metric (mean dev %, max dev %, p99 %, convergence rate, deviation
// integral, max consec out-of-threshold) plus a per-metric direction flag so
// the analyzer can pick winners correctly.
//
// Tiers:
//   1. Symmetric tier — `attackCategory: "both"` attackers run on BOTH
//      aggregators (apples-to-apples comparison).
//   2. Asymmetric tier — mode-specific attackers run only under their target
//      aggregator (no cross-mode comparison).
//
// Worst case per metric: for `direction: "low"` metrics it's the MAXIMUM
// observed value; for `direction: "high"` it's the MINIMUM. The aggregator
// with the better worst-case is the more robust default.
// ─────────────────────────────────────────────────────────────────────────────

interface RowKey {
  attacker: ValidatorType | "honest";
  fraction: number;
}

function classify(config: SimulationConfig): RowKey {
  let total = 0;
  let nonHonest: { type: ValidatorType; count: number } | null = null;
  for (const g of config.validators) {
    total += g.count;
    if (g.type !== "honest" && g.count > 0) nonHonest = { type: g.type, count: g.count };
  }
  if (!nonHonest || total === 0) return { attacker: "honest", fraction: 0 };
  return { attacker: nonHonest.type, fraction: nonHonest.count / total };
}

const keyOf = (k: RowKey) => `${k.attacker}@${(k.fraction * 100).toFixed(0)}%`;

type AggregatorTag = "median" | "nudge";
function aggregatorTag(config: SimulationConfig): AggregatorTag {
  return config.aggregator?.kind === "nudge" ? "nudge" : "median";
}

const pad = (s: string, n: number): string => s.length >= n ? s : s + " ".repeat(n - s.length);

interface Bucket {
  key: RowKey;
  attackerCategory: "both" | "median" | "nudge";
  /** Median's value (undefined if median-side wasn't run). */
  medianValue: number | undefined;
  /** Best-of-nudge value (undefined if nudge-side wasn't run). "Best" is
   *  direction-aware: lowest for "low" metrics, highest for "high". */
  bestNudgeValue: number | undefined;
  bestNudgeLabel: string | undefined;
}

/** Pick the better value of `a` vs `b` according to direction; returns the
 *  one that beats the other. Treats undefined as "no contender". */
function isBetter(a: number, b: number, direction: Metric["direction"]): boolean {
  return direction === "low" ? a < b : a > b;
}

function gather(results: SimulationResult[], metric: Metric): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  for (const r of results) {
    const key = classify(r.config);
    const id = keyOf(key);
    const tag = aggregatorTag(r.config);
    const v = metric.value(r.summary);
    let bucket = buckets.get(id);
    if (!bucket) {
      const cat = key.attacker === "honest" ? "both" : VALIDATOR_METADATA[key.attacker].attackCategory;
      bucket = {
        key,
        attackerCategory: cat,
        medianValue: undefined,
        bestNudgeValue: undefined,
        bestNudgeLabel: undefined,
      };
      buckets.set(id, bucket);
    }
    if (tag === "median") {
      bucket.medianValue = v;
    } else {
      const m = r.config.label.match(/ε=([^\s·]+)/);
      const epsLabel = m ? m[1] : "?";
      if (bucket.bestNudgeValue === undefined || isBetter(v, bucket.bestNudgeValue, metric.direction)) {
        bucket.bestNudgeValue = v;
        bucket.bestNudgeLabel = epsLabel;
      }
    }
  }
  return buckets;
}

function sortRows(rows: Bucket[]): Bucket[] {
  return [...rows].sort((a, b) => {
    if (a.key.attacker === "honest") return -1;
    if (b.key.attacker === "honest") return 1;
    const cmp = a.key.attacker.localeCompare(b.key.attacker);
    return cmp !== 0 ? cmp : a.key.fraction - b.key.fraction;
  });
}

function fmt(metric: Metric, v: number | undefined): string {
  return v === undefined || isNaN(v) ? "    n/a" : metric.format(v);
}

// ── Per-metric table rendering ──────────────────────────────────────────────

function printSymmetricTable(metric: Metric, rows: Bucket[]): { medianBetter: number; nudgeBetter: number; ties: number } {
  console.log(`\n  ┌─ Symmetric tier (apples-to-apples; lower = better is the convention for ${metric.direction === "low" ? "this metric" : "deviation lenses, higher = better here"})`);
  console.log(`  │  ${pad("attacker", 22)} ${pad("median", 14)}  ${pad("nudge(best ε)", 24)}  Δ (med−nudge)   winner`);
  let medianBetter = 0, nudgeBetter = 0, ties = 0;
  for (const r of rows) {
    if (r.medianValue === undefined || r.bestNudgeValue === undefined) continue;
    const diff = r.medianValue - r.bestNudgeValue;
    let winner: string;
    if (Math.abs(diff) < 1e-9) { winner = "tie"; ties++; }
    else if (isBetter(r.medianValue, r.bestNudgeValue, metric.direction)) { winner = "median"; medianBetter++; }
    else { winner = "nudge"; nudgeBetter++; }
    const diffStr = (diff >= 0 ? "+" : "") + metric.format(Math.abs(diff)).replace(metric.unit, "") + metric.unit;
    const nudgeCol = `${fmt(metric, r.bestNudgeValue)} (ε=${r.bestNudgeLabel ?? "?"})`;
    console.log(`  │  ${pad(keyOf(r.key), 22)} ${pad(fmt(metric, r.medianValue), 14)}  ${pad(nudgeCol, 24)}  ${pad(diffStr, 14)}  ${winner}`);
  }
  console.log(`  └─ subtotal: median better ${medianBetter}, nudge better ${nudgeBetter}, ties ${ties}`);
  return { medianBetter, nudgeBetter, ties };
}

function printAsymmetricMedianTable(metric: Metric, rows: Bucket[]): void {
  const applicable = rows.filter(r => r.attackerCategory === "median" && r.medianValue !== undefined);
  if (applicable.length === 0) return;
  console.log(`\n  ┌─ Median-only tier (these attackers do not run under nudge)`);
  console.log(`  │  ${pad("attacker", 28)} ${pad("median", 14)}`);
  for (const r of applicable) {
    console.log(`  │  ${pad(keyOf(r.key), 28)} ${fmt(metric, r.medianValue)}`);
  }
  console.log(`  └─`);
}

function printAsymmetricNudgeTable(metric: Metric, rows: Bucket[]): void {
  const applicable = rows.filter(r => r.attackerCategory === "nudge" && r.bestNudgeValue !== undefined);
  if (applicable.length === 0) return;
  console.log(`\n  ┌─ Nudge-only tier (these attackers do not run under median)`);
  console.log(`  │  ${pad("attacker", 28)} ${pad("nudge(best ε)", 24)}`);
  for (const r of applicable) {
    const nudgeCol = `${fmt(metric, r.bestNudgeValue)} (ε=${r.bestNudgeLabel ?? "?"})`;
    console.log(`  │  ${pad(keyOf(r.key), 28)} ${nudgeCol}`);
  }
  console.log(`  └─`);
}

interface WorstCase {
  median: { value: number; attacker: string } | undefined;
  nudge:  { value: number; attacker: string } | undefined;
}

/** For each aggregator, find the value at its worst-case applicable attacker
 *  (excluding the honest baseline). "Worst" is direction-aware. */
function computeWorstCase(metric: Metric, rows: Bucket[]): WorstCase {
  let median: WorstCase["median"] = undefined;
  let nudge:  WorstCase["nudge"]  = undefined;
  const isWorse = (a: number, b: number) => isBetter(b, a, metric.direction);
  for (const r of rows) {
    if (r.key.attacker === "honest") continue;
    if (r.medianValue !== undefined) {
      if (median === undefined || isWorse(r.medianValue, median.value)) {
        median = { value: r.medianValue, attacker: keyOf(r.key) };
      }
    }
    if (r.bestNudgeValue !== undefined) {
      if (nudge === undefined || isWorse(r.bestNudgeValue, nudge.value)) {
        nudge = { value: r.bestNudgeValue, attacker: keyOf(r.key) };
      }
    }
  }
  return { median, nudge };
}

function printWorstCase(metric: Metric, w: WorstCase): "median" | "nudge" | "tie" | "n/a" {
  console.log(`\n  ┌─ Worst case (${metric.direction === "low" ? "max" : "min"}) under ${metric.name}`);
  if (w.median) {
    console.log(`  │  median: ${pad(metric.format(w.median.value), 14)} (worst attacker: ${w.median.attacker})`);
  } else {
    console.log(`  │  median:     n/a   (no median-side runs)`);
  }
  if (w.nudge) {
    console.log(`  │  nudge : ${pad(metric.format(w.nudge.value), 14)} (worst attacker: ${w.nudge.attacker})`);
  } else {
    console.log(`  │  nudge :     n/a   (no nudge-side runs)`);
  }
  if (w.median && w.nudge) {
    const diff = w.median.value - w.nudge.value;
    let robustWinner: "median" | "nudge" | "tie";
    if (Math.abs(diff) < 1e-9) robustWinner = "tie";
    else if (isBetter(w.median.value, w.nudge.value, metric.direction)) robustWinner = "median";
    else robustWinner = "nudge";
    const diffStr = (diff >= 0 ? "+" : "") + metric.format(Math.abs(diff)).replace(metric.unit, "") + metric.unit;
    console.log(`  │  Δ (median − nudge) = ${diffStr}  →  more-robust: ${robustWinner}`);
    console.log(`  └─`);
    return robustWinner;
  }
  console.log(`  └─`);
  return "n/a";
}

// ── Top-level driver ────────────────────────────────────────────────────────

export function analyzeMedianVsNudge(results: SimulationResult[]): void {
  console.log(`\n╔════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║ Median-vs-Nudge validation (raw-value reporting, two-tier framework)       ║`);
  console.log(`║                                                                            ║`);
  console.log(`║   Each metric reports the actual measured value (% deviation, block count, ║`);
  console.log(`║   etc.) — no normalisation that would hide saturated failures.             ║`);
  console.log(`║                                                                            ║`);
  console.log(`║   Symmetric tier   : "both"-category attackers run on BOTH aggregators.    ║`);
  console.log(`║   Asymmetric tiers : mode-specific attackers run only on their target.     ║`);
  console.log(`║   Worst case       : per-aggregator worst value across applicable          ║`);
  console.log(`║                      attackers. Direction-aware (low/high is better).      ║`);
  console.log(`║                                                                            ║`);
  console.log(`║   ${results.length.toString().padStart(3)} simulations · ${METRICS.length} metrics                                          ║`);
  console.log(`╚════════════════════════════════════════════════════════════════════════════╝`);

  const symOverall = { medianBetter: 0, nudgeBetter: 0, ties: 0 };
  const lensWorst: Array<{ metric: Metric; worst: WorstCase; robustWinner: "median" | "nudge" | "tie" | "n/a" }> = [];

  for (const metric of METRICS) {
    const dirNote = metric.direction === "low" ? "lower is better" : "higher is better";
    console.log(`\n══ Metric: ${metric.name} (${dirNote}) ${"═".repeat(Math.max(0, 50 - metric.name.length))}`);
    console.log(`   ${metric.description}`);
    const buckets = gather(results, metric);
    const rows = sortRows([...buckets.values()]);

    const sym = printSymmetricTable(metric, rows);
    symOverall.medianBetter += sym.medianBetter;
    symOverall.nudgeBetter  += sym.nudgeBetter;
    symOverall.ties         += sym.ties;

    printAsymmetricMedianTable(metric, rows);
    printAsymmetricNudgeTable(metric, rows);

    const worst = computeWorstCase(metric, rows);
    const robustWinner = printWorstCase(metric, worst);
    lensWorst.push({ metric, worst, robustWinner });
  }

  // Cross-metric summary.
  console.log(`\n══ Overall ════════════════════════════════════════════════════════════════════`);
  console.log(`\n   Symmetric tier (apples-to-apples comparisons across all metrics):`);
  console.log(`     median better : ${symOverall.medianBetter}`);
  console.log(`     nudge  better : ${symOverall.nudgeBetter}`);
  console.log(`     ties          : ${symOverall.ties}`);

  console.log(`\n   Worst case per metric (honest baseline excluded):`);
  for (const { metric, worst } of lensWorst) {
    const m = worst.median ? `${metric.format(worst.median.value)} (${worst.median.attacker})` : "n/a";
    const n = worst.nudge  ? `${metric.format(worst.nudge.value)} (${worst.nudge.attacker})`   : "n/a";
    console.log(`     ${pad(metric.name, 32)} median: ${pad(m, 38)} │ nudge: ${n}`);
  }

  // Aggregate verdict — count metrics where each aggregator has the better worst case.
  let medianBetterCount = 0, nudgeBetterCount = 0, tieCount = 0, totalCompared = 0;
  for (const { robustWinner } of lensWorst) {
    if (robustWinner === "n/a") continue;
    totalCompared++;
    if (robustWinner === "median") medianBetterCount++;
    else if (robustWinner === "nudge") nudgeBetterCount++;
    else tieCount++;
  }
  console.log(`\n   Robustness verdict (which aggregator's worst case is better, per metric):`);
  console.log(`     median better : ${medianBetterCount} / ${totalCompared}`);
  console.log(`     nudge  better : ${nudgeBetterCount} / ${totalCompared}`);
  console.log(`     tie           : ${tieCount} / ${totalCompared}`);
  if (nudgeBetterCount > medianBetterCount) {
    console.log(`\n   CONCLUSION: nudge has the better worst case in more metrics — nudge is the more robust default.`);
  } else if (medianBetterCount > nudgeBetterCount) {
    console.log(`\n   CONCLUSION: median has the better worst case in more metrics — median is the more robust default.`);
  } else {
    console.log(`\n   CONCLUSION: worst-case results are mixed — neither aggregator is clearly more robust across all metrics.`);
  }
}

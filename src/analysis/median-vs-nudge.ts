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

type AggregatorTag = "median" | "nudge" | "adaptive";
function aggregatorTag(config: SimulationConfig): AggregatorTag {
  const k = config.aggregator?.kind;
  if (k === "nudge") return "nudge";
  if (k === "nudge-adaptive") return "adaptive";
  return "median";
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
  /** Best-of-nudge-adaptive value (undefined if adaptive-side wasn't run). */
  bestAdaptiveValue: number | undefined;
  bestAdaptiveLabel: string | undefined;
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
        bestAdaptiveValue: undefined,
        bestAdaptiveLabel: undefined,
      };
      buckets.set(id, bucket);
    }
    if (tag === "median") {
      bucket.medianValue = v;
    } else if (tag === "nudge") {
      const m = r.config.label.match(/ε=([^\s·]+)/);
      const epsLabel = m ? m[1] : "?";
      if (bucket.bestNudgeValue === undefined || isBetter(v, bucket.bestNudgeValue, metric.direction)) {
        bucket.bestNudgeValue = v;
        bucket.bestNudgeLabel = epsLabel;
      }
    } else /* adaptive */ {
      const m = r.config.label.match(/ε=([^\s·]+)/);
      const epsLabel = m ? m[1] : "?";
      if (bucket.bestAdaptiveValue === undefined || isBetter(v, bucket.bestAdaptiveValue, metric.direction)) {
        bucket.bestAdaptiveValue = v;
        bucket.bestAdaptiveLabel = epsLabel;
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

function printSymmetricTable(metric: Metric, rows: Bucket[]): { medianBetter: number; nudgeBetter: number; adaptiveBetter: number; ties: number } {
  const hasAdaptive = rows.some(r => r.bestAdaptiveValue !== undefined);
  console.log(`\n  ┌─ Symmetric tier (apples-to-apples; ${metric.direction === "low" ? "lower" : "higher"} is better)`);
  if (hasAdaptive) {
    console.log(`  │  ${pad("attacker", 22)} ${pad("median", 14)}  ${pad("nudge(best ε)", 24)}  ${pad("adaptive(best ε)", 24)}  winner`);
  } else {
    console.log(`  │  ${pad("attacker", 22)} ${pad("median", 14)}  ${pad("nudge(best ε)", 24)}  Δ (med−nudge)   winner`);
  }
  let medianBetter = 0, nudgeBetter = 0, adaptiveBetter = 0, ties = 0;
  for (const r of rows) {
    if (r.medianValue === undefined || r.bestNudgeValue === undefined) continue;
    // Determine winner across {median, nudge, adaptive} (the latter only when present).
    const candidates: Array<{ name: string; value: number }> = [
      { name: "median", value: r.medianValue },
      { name: "nudge",  value: r.bestNudgeValue },
    ];
    if (r.bestAdaptiveValue !== undefined) {
      candidates.push({ name: "adaptive", value: r.bestAdaptiveValue });
    }
    candidates.sort((a, b) => isBetter(a.value, b.value, metric.direction) ? -1 : isBetter(b.value, a.value, metric.direction) ? 1 : 0);
    const top = candidates[0];
    const second = candidates[1];
    const winner = (Math.abs(top.value - second.value) < 1e-9) ? "tie" : top.name;
    if (winner === "tie") ties++;
    else if (winner === "median")   medianBetter++;
    else if (winner === "nudge")    nudgeBetter++;
    else if (winner === "adaptive") adaptiveBetter++;

    const nudgeCol = `${fmt(metric, r.bestNudgeValue)} (ε=${r.bestNudgeLabel ?? "?"})`;
    if (hasAdaptive) {
      const adaptCol = r.bestAdaptiveValue !== undefined
        ? `${fmt(metric, r.bestAdaptiveValue)} (ε=${r.bestAdaptiveLabel ?? "?"})`
        : "n/a";
      console.log(`  │  ${pad(keyOf(r.key), 22)} ${pad(fmt(metric, r.medianValue), 14)}  ${pad(nudgeCol, 24)}  ${pad(adaptCol, 24)}  ${winner}`);
    } else {
      const diff = r.medianValue - r.bestNudgeValue;
      const diffStr = (diff >= 0 ? "+" : "") + metric.format(Math.abs(diff)).replace(metric.unit, "") + metric.unit;
      console.log(`  │  ${pad(keyOf(r.key), 22)} ${pad(fmt(metric, r.medianValue), 14)}  ${pad(nudgeCol, 24)}  ${pad(diffStr, 14)}  ${winner}`);
    }
  }
  if (hasAdaptive) {
    console.log(`  └─ subtotal: median better ${medianBetter}, nudge better ${nudgeBetter}, adaptive better ${adaptiveBetter}, ties ${ties}`);
  } else {
    console.log(`  └─ subtotal: median better ${medianBetter}, nudge better ${nudgeBetter}, ties ${ties}`);
  }
  return { medianBetter, nudgeBetter, adaptiveBetter, ties };
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
  median:   { value: number; attacker: string } | undefined;
  nudge:    { value: number; attacker: string } | undefined;
  adaptive: { value: number; attacker: string } | undefined;
}

/** For each aggregator, find the value at its worst-case applicable attacker
 *  (excluding the honest baseline). "Worst" is direction-aware. */
function computeWorstCase(metric: Metric, rows: Bucket[]): WorstCase {
  let median:   WorstCase["median"]   = undefined;
  let nudge:    WorstCase["nudge"]    = undefined;
  let adaptive: WorstCase["adaptive"] = undefined;
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
    if (r.bestAdaptiveValue !== undefined) {
      if (adaptive === undefined || isWorse(r.bestAdaptiveValue, adaptive.value)) {
        adaptive = { value: r.bestAdaptiveValue, attacker: keyOf(r.key) };
      }
    }
  }
  return { median, nudge, adaptive };
}

type RobustWinner = "median" | "nudge" | "adaptive" | "tie" | "n/a";

function printWorstCase(metric: Metric, w: WorstCase): RobustWinner {
  console.log(`\n  ┌─ Worst case (${metric.direction === "low" ? "max" : "min"}) under ${metric.name}`);
  const print = (label: string, c: { value: number; attacker: string } | undefined): void => {
    if (c) console.log(`  │  ${pad(label, 9)}: ${pad(metric.format(c.value), 14)} (worst attacker: ${c.attacker})`);
    else   console.log(`  │  ${pad(label, 9)}:     n/a   (no runs)`);
  };
  print("median",   w.median);
  print("nudge",    w.nudge);
  print("adaptive", w.adaptive);

  const candidates: Array<{ name: "median" | "nudge" | "adaptive"; value: number }> = [];
  if (w.median)   candidates.push({ name: "median",   value: w.median.value });
  if (w.nudge)    candidates.push({ name: "nudge",    value: w.nudge.value });
  if (w.adaptive) candidates.push({ name: "adaptive", value: w.adaptive.value });

  if (candidates.length < 2) {
    console.log(`  └─`);
    return "n/a";
  }
  candidates.sort((a, b) => isBetter(a.value, b.value, metric.direction) ? -1 : isBetter(b.value, a.value, metric.direction) ? 1 : 0);
  const top = candidates[0];
  const second = candidates[1];
  const winner: RobustWinner = (Math.abs(top.value - second.value) < 1e-9) ? "tie" : top.name;
  console.log(`  │  more-robust: ${winner} (best worst-case: ${metric.format(top.value)})`);
  console.log(`  └─`);
  return winner;
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

  const symOverall = { medianBetter: 0, nudgeBetter: 0, adaptiveBetter: 0, ties: 0 };
  const lensWorst: Array<{ metric: Metric; worst: WorstCase; robustWinner: RobustWinner }> = [];

  for (const metric of METRICS) {
    const dirNote = metric.direction === "low" ? "lower is better" : "higher is better";
    console.log(`\n══ Metric: ${metric.name} (${dirNote}) ${"═".repeat(Math.max(0, 50 - metric.name.length))}`);
    console.log(`   ${metric.description}`);
    const buckets = gather(results, metric);
    const rows = sortRows([...buckets.values()]);

    const sym = printSymmetricTable(metric, rows);
    symOverall.medianBetter   += sym.medianBetter;
    symOverall.nudgeBetter    += sym.nudgeBetter;
    symOverall.adaptiveBetter += sym.adaptiveBetter;
    symOverall.ties           += sym.ties;

    printAsymmetricMedianTable(metric, rows);
    printAsymmetricNudgeTable(metric, rows);

    const worst = computeWorstCase(metric, rows);
    const robustWinner = printWorstCase(metric, worst);
    lensWorst.push({ metric, worst, robustWinner });
  }

  // Cross-metric summary.
  console.log(`\n══ Overall ════════════════════════════════════════════════════════════════════`);
  console.log(`\n   Symmetric tier (apples-to-apples comparisons across all metrics):`);
  console.log(`     median   better : ${symOverall.medianBetter}`);
  console.log(`     nudge    better : ${symOverall.nudgeBetter}`);
  console.log(`     adaptive better : ${symOverall.adaptiveBetter}`);
  console.log(`     ties            : ${symOverall.ties}`);

  console.log(`\n   Worst case per metric (honest baseline excluded):`);
  for (const { metric, worst } of lensWorst) {
    const m = worst.median   ? `${metric.format(worst.median.value)} (${worst.median.attacker})`     : "n/a";
    const n = worst.nudge    ? `${metric.format(worst.nudge.value)} (${worst.nudge.attacker})`       : "n/a";
    const a = worst.adaptive ? `${metric.format(worst.adaptive.value)} (${worst.adaptive.attacker})` : "n/a";
    console.log(`     ${pad(metric.name, 32)} median: ${pad(m, 38)} │ nudge: ${pad(n, 32)} │ adaptive: ${a}`);
  }

  // Aggregate verdict — count metrics where each aggregator has the better worst case.
  const counts = { median: 0, nudge: 0, adaptive: 0, tie: 0 };
  let totalCompared = 0;
  for (const { robustWinner } of lensWorst) {
    if (robustWinner === "n/a") continue;
    totalCompared++;
    counts[robustWinner]++;
  }
  console.log(`\n   Robustness verdict (which aggregator's worst case is the best, per metric):`);
  console.log(`     median   better : ${counts.median}   / ${totalCompared}`);
  console.log(`     nudge    better : ${counts.nudge}    / ${totalCompared}`);
  console.log(`     adaptive better : ${counts.adaptive} / ${totalCompared}`);
  console.log(`     tie             : ${counts.tie}      / ${totalCompared}`);
  const winners = (["median", "nudge", "adaptive"] as const).map(k => ({ k, c: counts[k] }))
    .sort((a, b) => b.c - a.c);
  if (winners[0].c === winners[1].c) {
    console.log(`\n   CONCLUSION: worst-case results are mixed — no single aggregator is clearly more robust across all metrics.`);
  } else {
    console.log(`\n   CONCLUSION: ${winners[0].k} has the best worst case in more metrics — ${winners[0].k} is the most robust default.`);
  }
}

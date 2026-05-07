import type { SimulationResult, SimulationConfig, ValidatorType } from "../types.js";
import { SCORING_FUNCTIONS, type ScoringFunction } from "./scoring-functions.js";

/** A single (attacker, fraction) row in the comparison matrix. */
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

/** Per-row aggregation across the 4 aggregator configs (median + 3 nudge ε's). */
interface RowComparison {
  key: RowKey;
  medianScore: number;
  bestNudgeScore: number;
  bestNudgeLabel: string;        // which ε won
  allNudgeScores: Array<{ label: string; score: number }>;
}

function compareRows(
  results: SimulationResult[],
  scorer: ScoringFunction,
): RowComparison[] {
  // Group results by row key.
  const rows = new Map<string, { key: RowKey; results: SimulationResult[] }>();
  for (const r of results) {
    const k = classify(r.config);
    const id = keyOf(k);
    if (!rows.has(id)) rows.set(id, { key: k, results: [] });
    rows.get(id)!.results.push(r);
  }

  const out: RowComparison[] = [];
  for (const { key, results: bucket } of rows.values()) {
    let medianScore = NaN;
    const nudgeScores: Array<{ label: string; score: number }> = [];
    for (const r of bucket) {
      const score = scorer.score(r.summary);
      const agg = r.config.aggregator;
      if (!agg || agg.kind === "median") {
        medianScore = score;
      } else if (agg.kind === "nudge") {
        // Pull ε label off the scenario label suffix if present.
        const m = r.config.label.match(/ε=([^\s·]+)/);
        nudgeScores.push({ label: m ? m[1] : String(agg.epsilon), score });
      }
    }
    nudgeScores.sort((a, b) => b.score - a.score);
    const best = nudgeScores[0] ?? { label: "?", score: NaN };
    out.push({
      key,
      medianScore,
      bestNudgeScore: best.score,
      bestNudgeLabel: best.label,
      allNudgeScores: nudgeScores,
    });
  }

  // Stable sort: honest first, then by attacker name, then by fraction asc.
  out.sort((a, b) => {
    if (a.key.attacker === "honest") return -1;
    if (b.key.attacker === "honest") return 1;
    const cmp = a.key.attacker.localeCompare(b.key.attacker);
    return cmp !== 0 ? cmp : a.key.fraction - b.key.fraction;
  });
  return out;
}

const fmt = (x: number) => isNaN(x) ? "  n/a " : x.toFixed(4);
const pad = (s: string, n: number) => s.length >= n ? s : s + " ".repeat(n - s.length);

/** Print a comparison table for one scoring function. Returns counts for the
 *  per-scorer summary line. */
function printTable(scorer: ScoringFunction, rows: RowComparison[]): { wins: number; losses: number; ties: number } {
  console.log(`\n── Scoring: ${scorer.name} ${"─".repeat(Math.max(0, 60 - scorer.name.length))}`);
  console.log(`   ${scorer.description}`);
  console.log(`   ${pad("attacker", 22)} ${pad("median", 8)}  ${pad("nudge(best ε)", 18)}  gap        verdict`);
  let wins = 0, losses = 0, ties = 0;
  for (const r of rows) {
    const gap = r.medianScore - r.bestNudgeScore;
    let verdict: string;
    if (Math.abs(gap) < 1e-6) { verdict = "tie";    ties++;   }
    else if (gap > 0)         { verdict = "median"; wins++;   }
    else                      { verdict = "nudge";  losses++; }
    const gapStr = (gap >= 0 ? "+" : "") + gap.toFixed(4);
    const nudgeCol = `${fmt(r.bestNudgeScore)} (ε=${r.bestNudgeLabel})`;
    console.log(`   ${pad(keyOf(r.key), 22)} ${fmt(r.medianScore)}  ${pad(nudgeCol, 18)}  ${pad(gapStr, 9)}  ${verdict}`);
  }
  console.log(`   ── median wins ${wins}, nudge wins ${losses}, ties ${ties} (out of ${rows.length})`);
  return { wins, losses, ties };
}

/** Top-level: evaluate every scoring function over the given results and
 *  print a verdict table per function plus an overall summary. */
export function analyzeMedianVsNudge(results: SimulationResult[]): void {
  console.log(`\n╔════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║ Median-vs-Nudge validation                                                 ║`);
  console.log(`║   ${results.length} simulations across ${SCORING_FUNCTIONS.length} scoring lenses.                              ║`);
  console.log(`║   "median wins" = median's score is higher (=better) than the best of the  ║`);
  console.log(`║   three nudge-ε variants for the same (attacker, fraction).                ║`);
  console.log(`╚════════════════════════════════════════════════════════════════════════════╝`);

  const tally = { wins: 0, losses: 0, ties: 0, total: 0 };
  for (const scorer of SCORING_FUNCTIONS) {
    const rows = compareRows(results, scorer);
    const counts = printTable(scorer, rows);
    tally.wins   += counts.wins;
    tally.losses += counts.losses;
    tally.ties   += counts.ties;
    tally.total  += rows.length;
  }

  console.log(`\n══ Overall ════════════════════════════════════════════════════════════════════`);
  console.log(`   Total comparisons: ${tally.total}  (${SCORING_FUNCTIONS.length} scoring lenses × rows-per-lens)`);
  console.log(`   median wins : ${tally.wins}`);
  console.log(`   nudge wins  : ${tally.losses}`);
  console.log(`   ties        : ${tally.ties}`);
  if (tally.losses === 0) {
    console.log(`\n   CONCLUSION: median dominates — nudge never beats median in any lens.`);
  } else {
    console.log(`\n   CONCLUSION: nudge wins ${tally.losses} comparison(s); median is NOT a strict dominant.`);
  }
}

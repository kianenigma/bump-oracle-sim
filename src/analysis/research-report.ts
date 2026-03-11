import { join } from "path";
import type { SimulationResult } from "../types.js";
import { scoreSimulation, scoreEpsilons, type ResearchCriteria, type EpsilonScore } from "./research-criteria.js";

interface DetailRow {
  epsilon: number;
  multiplier: number;
  mix: string;
  convergenceRate: number;
  meanDeviationPct: number;
  maxDeviationPct: number;
  deviationIntegral: number;
  score: number;
}

interface ResearchReport {
  criteria: ResearchCriteria;
  autoEpsilon: number;
  ranking: EpsilonScore[];
  details: DetailRow[];
  conclusion: { optimalEpsilon: number; multiplier: number; compositeScore: number };
}

/**
 * Generate a research report: print formatted table to stdout and save JSON.
 */
export function generateReport(
  results: SimulationResult[],
  epsilonMultipliers: Map<number, number>,
  criteria: ResearchCriteria,
  autoEpsilon: number,
  outputPath: string,
): void {
  const ranking = scoreEpsilons(results, epsilonMultipliers, criteria);

  // Build detail rows
  const details: DetailRow[] = [];
  for (const r of results) {
    const eps = r.config.epsilon as number;
    const mult = epsilonMultipliers.get(eps) ?? 0;
    const mix = formatMix(r.config.validatorMix);
    details.push({
      epsilon: eps,
      multiplier: mult,
      mix,
      convergenceRate: r.summary.convergenceRate,
      meanDeviationPct: r.summary.meanDeviationPct,
      maxDeviationPct: r.summary.maxDeviationPct,
      deviationIntegral: r.summary.deviationIntegral,
      score: scoreSimulation(r.summary, criteria),
    });
  }

  // Sort details by epsilon then mix
  details.sort((a, b) => a.epsilon - b.epsilon || a.mix.localeCompare(b.mix));

  const best = ranking[0];
  const totalSims = results.length;
  const totalBlocks = results[0]?.summary.totalBlocks ?? 0;
  const startDate = results[0]?.config.startDate ?? "?";
  const endDate = results[0]?.config.endDate ?? "?";

  // Print to stdout
  console.log(`\n${"=".repeat(80)}`);
  console.log(`RESEARCH REPORT`);
  console.log(`${"=".repeat(80)}`);
  console.log(`Date range: ${startDate} to ${endDate} | ${totalBlocks.toLocaleString()} blocks/sim | ${totalSims} simulations`);
  console.log(`Auto-epsilon base: ${autoEpsilon.toFixed(6)}`);

  console.log(`\nEPSILON RANKING (by composite score):`);
  for (let i = 0; i < ranking.length; i++) {
    const r = ranking[i];
    console.log(
      `  #${i + 1}  eps=${r.epsilon.toFixed(6)} (${r.multiplier.toFixed(1)}x)` +
      `  score=${r.compositeScore.toFixed(3)}` +
      `  baseline=${r.baselineScore.toFixed(2)}` +
      `  worst@33%=${r.worstScore33.toFixed(2)}` +
      `  gap=${r.resilienceGap.toFixed(2)}`
    );
  }

  console.log(`\nDETAIL TABLE:`);
  console.log(`  ${"epsilon".padEnd(14)} ${"mix".padEnd(22)} ${"convRate".padEnd(10)} ${"meanDev%".padEnd(10)} ${"maxDev%".padEnd(10)} ${"integral".padEnd(12)} ${"score".padEnd(8)}`);
  console.log(`  ${"-".repeat(86)}`);
  for (const d of details) {
    console.log(
      `  ${d.epsilon.toFixed(6).padEnd(14)} ` +
      `${d.mix.padEnd(22)} ` +
      `${(d.convergenceRate * 100).toFixed(1).padStart(6)}%   ` +
      `${d.meanDeviationPct.toFixed(4).padStart(8)}  ` +
      `${d.maxDeviationPct.toFixed(4).padStart(8)}  ` +
      `${d.deviationIntegral.toFixed(1).padStart(10)}  ` +
      `${d.score.toFixed(3).padStart(6)}`
    );
  }

  console.log(`\nCONCLUSION: Optimal epsilon = ${best.epsilon.toFixed(6)} (${best.multiplier.toFixed(1)}x auto-epsilon)`);
  console.log(`${"=".repeat(80)}\n`);

  // Write JSON report
  const report: ResearchReport = {
    criteria,
    autoEpsilon,
    ranking,
    details,
    conclusion: {
      optimalEpsilon: best.epsilon,
      multiplier: best.multiplier,
      compositeScore: best.compositeScore,
    },
  };

  Bun.write(outputPath, JSON.stringify(report, null, 2));
  console.log(`Report saved to ${outputPath}`);
}

function formatMix(mix: Record<string, number>): string {
  const entries = Object.entries(mix);
  if (entries.length === 0) return "0% (baseline)";
  return entries.map(([k, v]) => `${(v * 100).toFixed(0)}% ${k}`).join(", ");
}

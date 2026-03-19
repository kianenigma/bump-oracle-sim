import { join } from "path";
import { epsilonValue, epsilonMode as getEpsilonMode } from "../types.js";
import type { SimulationResult, EpsilonMode } from "../types.js";
import { scoreSimulation, scoreEpsilons, type ResearchCriteria, type EpsilonScore } from "./research-criteria.js";
import { formatMix } from "../mix.js";

interface DetailRow {
  epsilon: number;
  epsilonMode: EpsilonMode;
  multiplier: number;
  mix: string;
  convergenceRate: number;
  meanDeviationPct: number;
  maxDeviationPct: number;
  p95DeviationPct: number;
  p99DeviationPct: number;
  maxConsecAbove: number;
  deviationIntegral: number;
  score: number;
}

interface InterpolatedOptimum {
  epsilon: number;
  multiplier: number;
  estimatedScore: number;
  method: string;
  coefficients: [number, number, number];
}

interface ResearchReport {
  criteria: ResearchCriteria;
  autoEpsilon: number;
  ranking: EpsilonScore[];
  details: DetailRow[];
  interpolated: InterpolatedOptimum | null;
  conclusion: { optimalEpsilon: number; epsilonMode: EpsilonMode; multiplier: number; compositeScore: number };
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
    const eps = epsilonValue(r.config.epsilon);
    const mode = getEpsilonMode(r.config.epsilon);
    const mult = epsilonMultipliers.get(eps) ?? 0;
    const mix = formatMix(r.config.validatorMix);
    details.push({
      epsilon: eps,
      epsilonMode: mode,
      multiplier: mult,
      mix,
      convergenceRate: r.summary.convergenceRate,
      meanDeviationPct: r.summary.meanDeviationPct,
      maxDeviationPct: r.summary.maxDeviationPct,
      p95DeviationPct: r.summary.p95DeviationPct ?? 0,
      p99DeviationPct: r.summary.p99DeviationPct ?? 0,
      maxConsecAbove: r.summary.maxConsecutiveBlocksAboveThreshold ?? 0,
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

  // Curve fitting: find interpolated optimum from grid scores
  const interpolated = fitQuadraticOptimum(ranking, autoEpsilon);

  // Print to stdout
  console.log(`\n${"=".repeat(90)}`);
  console.log(`RESEARCH REPORT`);
  console.log(`${"=".repeat(90)}`);
  console.log(`Date range: ${startDate} to ${endDate} | ${totalBlocks.toLocaleString()} blocks/sim | ${totalSims} simulations`);
  console.log(`Auto-epsilon base: ${autoEpsilon.toFixed(6)}`);

  console.log(`\nEPSILON RANKING (by composite score):`);
  for (let i = 0; i < ranking.length; i++) {
    const r = ranking[i];
    const modeTag = r.epsilonMode === "ratio" ? " [ratio]" : "";
    console.log(
      `  #${i + 1}  eps=${r.epsilon.toFixed(6)}${modeTag} (${r.multiplier.toFixed(1)}x)` +
      `  score=${r.compositeScore.toFixed(3)}` +
      `  baseline=${r.baselineScore.toFixed(2)}` +
      `  worst@33%=${r.worstScore33.toFixed(2)}` +
      `  gap=${r.resilienceGap.toFixed(2)}`
    );
  }

  if (interpolated) {
    console.log(`\nINTERPOLATED OPTIMUM (${interpolated.method}):`);
    console.log(`  eps=${interpolated.epsilon.toFixed(6)} (${interpolated.multiplier.toFixed(2)}x)  estimated score=${interpolated.estimatedScore.toFixed(3)}`);
    console.log(`  Grid best: eps=${best.epsilon.toFixed(6)} (${best.multiplier.toFixed(1)}x)  score=${best.compositeScore.toFixed(3)}`);
  }

  console.log(`\nDETAIL TABLE:`);
  console.log(
    `  ${"epsilon".padEnd(14)} ${"mode".padEnd(6)} ${"mix".padEnd(22)} ${"convRate".padEnd(10)} ${"meanDev%".padEnd(10)} ` +
    `${"maxDev%".padEnd(10)} ${"p95%".padEnd(8)} ${"p99%".padEnd(8)} ${"maxConsec".padEnd(10)} ` +
    `${"integral".padEnd(12)} ${"score".padEnd(8)}`
  );
  console.log(`  ${"-".repeat(120)}`);
  for (const d of details) {
    console.log(
      `  ${d.epsilon.toFixed(6).padEnd(14)} ` +
      `${d.epsilonMode.padEnd(6)} ` +
      `${d.mix.padEnd(22)} ` +
      `${(d.convergenceRate * 100).toFixed(1).padStart(6)}%   ` +
      `${d.meanDeviationPct.toFixed(4).padStart(8)}  ` +
      `${d.maxDeviationPct.toFixed(4).padStart(8)}  ` +
      `${d.p95DeviationPct.toFixed(4).padStart(6)}  ` +
      `${d.p99DeviationPct.toFixed(4).padStart(6)}  ` +
      `${String(d.maxConsecAbove).padStart(8)}  ` +
      `${d.deviationIntegral.toFixed(1).padStart(10)}  ` +
      `${d.score.toFixed(3).padStart(6)}`
    );
  }

  const conclusionEps = interpolated
    ? { epsilon: interpolated.epsilon, multiplier: interpolated.multiplier, mode: best.epsilonMode }
    : { epsilon: best.epsilon, multiplier: best.multiplier, mode: best.epsilonMode };
  const modeLabel = conclusionEps.mode === "ratio" ? " [ratio]" : "";
  console.log(`\nCONCLUSION: Optimal epsilon = ${conclusionEps.epsilon.toFixed(6)}${modeLabel} (${conclusionEps.multiplier.toFixed(2)}x)`);
  if (interpolated) {
    console.log(`  (interpolated from quadratic fit; grid best was ${best.multiplier.toFixed(1)}x)`);
  }
  console.log(`${"=".repeat(90)}\n`);

  // Write JSON report
  const report: ResearchReport = {
    criteria,
    autoEpsilon,
    ranking,
    details,
    interpolated,
    conclusion: {
      optimalEpsilon: conclusionEps.epsilon,
      epsilonMode: conclusionEps.mode,
      multiplier: conclusionEps.multiplier,
      compositeScore: interpolated?.estimatedScore ?? best.compositeScore,
    },
  };

  Bun.write(outputPath, JSON.stringify(report, null, 2));
  console.log(`Report saved to ${outputPath}`);
}

// ── Quadratic curve fitting ──

/**
 * Fit a quadratic y = ax² + bx + c to the (multiplier, compositeScore) points
 * from the epsilon ranking. If the parabola is concave (a < 0), find its vertex
 * as the interpolated optimum. Falls back to null if fitting fails.
 */
function fitQuadraticOptimum(
  ranking: EpsilonScore[],
  autoEpsilon: number,
): InterpolatedOptimum | null {
  if (ranking.length < 3) return null;

  // Use multiplier as x-axis (more numerically stable than raw epsilon)
  const xs = ranking.map(r => r.multiplier);
  const ys = ranking.map(r => r.compositeScore);

  const coeffs = fitQuadratic(xs, ys);
  if (!coeffs) return null;

  const [a, b] = coeffs;

  // Parabola must be concave (a < 0) for a maximum to exist
  if (a >= 0) return null;

  const optimalMult = -b / (2 * a);
  const optimalScore = a * optimalMult * optimalMult + b * optimalMult + coeffs[2];

  // Only accept if the optimum falls within a reasonable range of the grid
  const minMult = Math.min(...xs);
  const maxMult = Math.max(...xs);
  const margin = (maxMult - minMult) * 0.25;
  if (optimalMult < minMult - margin || optimalMult > maxMult + margin) return null;
  if (optimalScore < 0 || optimalScore > 1) return null;

  return {
    epsilon: optimalMult * autoEpsilon,
    multiplier: optimalMult,
    estimatedScore: optimalScore,
    method: "quadratic fit",
    coefficients: coeffs,
  };
}

/**
 * Least-squares quadratic regression: y = ax² + bx + c.
 * Solves the 3×3 normal equations via Cramer's rule.
 * Returns [a, b, c] or null if the system is singular.
 */
function fitQuadratic(xs: number[], ys: number[]): [number, number, number] | null {
  const n = xs.length;
  let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0;
  let sy = 0, sxy = 0, sx2y = 0;

  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    const x2 = x * x;
    sx += x;
    sx2 += x2;
    sx3 += x2 * x;
    sx4 += x2 * x2;
    sy += y;
    sxy += x * y;
    sx2y += x2 * y;
  }

  // Normal equations matrix: [sx4 sx3 sx2; sx3 sx2 sx; sx2 sx n] * [a; b; c] = [sx2y; sxy; sy]
  const det =
    sx4 * (sx2 * n - sx * sx) -
    sx3 * (sx3 * n - sx * sx2) +
    sx2 * (sx3 * sx - sx2 * sx2);

  if (Math.abs(det) < 1e-15) return null;

  const a = (
    sx2y * (sx2 * n - sx * sx) -
    sx3 * (sxy * n - sy * sx) +
    sx2 * (sxy * sx - sy * sx2)
  ) / det;

  const b = (
    sx4 * (sxy * n - sy * sx) -
    sx2y * (sx3 * n - sx * sx2) +
    sx2 * (sx3 * sy - sx2 * sxy)
  ) / det;

  const c = (
    sx4 * (sx2 * sy - sx * sxy) -
    sx3 * (sx3 * sy - sx * sx2y) +
    sx2y * (sx3 * sx - sx2 * sx2)
  ) / det;

  return [a, b, c];
}

import type { SimulationResult, SimDataFile } from "../types.js";

export function toSimData(results: SimulationResult[]): SimDataFile {
  return {
    version: 1,
    scenarios: results.map((r) => ({
      config: r.config,
      summary: r.summary,
      timestamps: r.metrics.map((m) => m.timestamp),
      realPrices: r.metrics.map((m) => m.realPrice),
      oraclePrices: r.metrics.map((m) => m.oraclePrice),
      deviationPcts: r.metrics.map((m) => m.deviationPct),
    })),
  };
}

export async function writeSimData(
  results: SimulationResult[],
  outputPath: string
): Promise<string> {
  const data = toSimData(results);
  const json = JSON.stringify(data);
  const sizeMB = (new TextEncoder().encode(json).length / 1_000_000).toFixed(1);
  await Bun.write(outputPath, json);
  console.log(`Simulation data written to ${outputPath} (${sizeMB} MB)`);
  return outputPath;
}

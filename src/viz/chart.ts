import { join } from "path";
import type { SimulationResult } from "../types.js";

const TEMPLATE_PATH = join(import.meta.dir, "template.html");

function downsample<T>(data: T[], maxPoints: number): T[] {
  if (data.length <= maxPoints) return data;
  const step = data.length / maxPoints;
  const result = [data[0]];
  for (let i = 1; i < maxPoints - 1; i++) {
    result.push(data[Math.round(i * step)]);
  }
  result.push(data[data.length - 1]);
  return result;
}

export async function generateStaticHtml(
  results: SimulationResult[],
  outputPath: string,
  downsampling: "none" | "auto" = "auto"
): Promise<string> {
  const template = await Bun.file(TEMPLATE_PATH).text();

  const chartData = results.map((r) => {
    let metrics = r.metrics;

    if (downsampling === "auto") {
      const perSeriesCap = Math.floor(500_000 / results.length);
      metrics = downsample(metrics, perSeriesCap);
      if (metrics.length < r.metrics.length) {
        const ratio = r.metrics.length / metrics.length;
        console.log(`  Downsampled ${r.config.label}: ${r.metrics.length} -> ${metrics.length} points (1:${ratio.toFixed(0)})`);
      }
    }

    return {
      config: r.config,
      summary: r.summary,
      metrics: metrics.map((m) => ({
        timestamp: m.timestamp,
        realPrice: m.realPrice,
        oraclePrice: m.oraclePrice,
        deviationPct: m.deviationPct,
      })),
    };
  });

  const configs = results.map((r) => r.config);

  const html = template
    .replace("/*DATA_PLACEHOLDER*/null", JSON.stringify(chartData))
    .replace("/*CONFIG_PLACEHOLDER*/null", JSON.stringify(configs));

  const sizeMB = (new TextEncoder().encode(html).length / 1_000_000).toFixed(1);
  await Bun.write(outputPath, html);
  console.log(`Chart written to ${outputPath} (${sizeMB} MB)`);
  return outputPath;
}

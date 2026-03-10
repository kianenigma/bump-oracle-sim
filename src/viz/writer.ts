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

/**
 * Write a numeric array to a file writer element-by-element to avoid
 * building a giant JSON string in memory.
 */
function writeNumericArray(
  sink: FileSink,
  metrics: SimulationResult["metrics"],
  accessor: (m: SimulationResult["metrics"][0]) => number
): void {
  sink.write("[");
  for (let i = 0; i < metrics.length; i++) {
    if (i > 0) sink.write(",");
    sink.write(String(accessor(metrics[i])));
  }
  sink.write("]");
}

type FileSink = ReturnType<ReturnType<typeof Bun.file>["writer"]>;

export async function writeSimData(
  results: SimulationResult[],
  outputPath: string
): Promise<string> {
  // Bun's FileSink opens with O_WRONLY|O_CREAT but NOT O_TRUNC,
  // so a previous larger file would leave trailing garbage. Truncate first.
  await Bun.write(outputPath, "");
  const writer = Bun.file(outputPath).writer();

  writer.write('{"version":1,"scenarios":[');

  for (let s = 0; s < results.length; s++) {
    if (s > 0) writer.write(",");
    const r = results[s];

    writer.write("{");
    writer.write(`"config":${JSON.stringify(r.config)},`);
    writer.write(`"summary":${JSON.stringify(r.summary)},`);

    writer.write('"timestamps":');
    writeNumericArray(writer, r.metrics, (m) => m.timestamp);
    writer.write(",");

    writer.write('"realPrices":');
    writeNumericArray(writer, r.metrics, (m) => m.realPrice);
    writer.write(",");

    writer.write('"oraclePrices":');
    writeNumericArray(writer, r.metrics, (m) => m.oraclePrice);
    writer.write(",");

    writer.write('"deviationPcts":');
    writeNumericArray(writer, r.metrics, (m) => m.deviationPct);

    writer.write("}");
  }

  writer.write("]}");
  await writer.end();

  const sizeMB = (Bun.file(outputPath).size / 1_000_000).toFixed(1);
  console.log(`Simulation data written to ${outputPath} (${sizeMB} MB)`);
  return outputPath;
}

import { join } from "path";
import { runSimulation } from "./engine.js";
import { ChunkWriter, CsvWriter, combineSinks, scenarioDirName } from "../viz/writer.js";
import type { ResolvedPriceSource, SimulationConfig, ScenarioMeta } from "../types.js";

declare var self: Worker;

let priceSource: ResolvedPriceSource;

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;

  if (msg.type === "init") {
    priceSource = msg.priceSource;
    self.postMessage({ type: "ready" });
    return;
  }

  if (msg.type === "run") {
    const config: SimulationConfig = msg.config;
    const scenarioIndex: number = msg.scenarioIndex;
    const outputDir: string | undefined = msg.outputDir;

    const dirName = scenarioDirName(config.label, scenarioIndex);
    let writer: ChunkWriter | undefined;
    let csv: CsvWriter | undefined;
    if (outputDir) {
      writer = new ChunkWriter(join(outputDir, dirName));
      csv = new CsvWriter(join(outputDir, `${dirName}.csv`));
    }

    const onProgress = (pct: number) => {
      self.postMessage({ type: "progress", pct, scenarioIndex });
    };

    const result = runSimulation(config, priceSource, combineSinks(writer?.sink, csv?.sink), true, onProgress);

    let meta: ScenarioMeta | undefined;
    if (writer) {
      const info = writer.finish();
      csv?.finish();
      meta = {
        config: result.config,
        summary: result.summary,
        blockCount: info.blockCount,
        chunkCount: info.chunkCount,
        timeRange: info.timeRange,
        chunkTimeRanges: info.chunkTimeRanges,
        dir: dirName,
      };
    }

    self.postMessage({ type: "done", result, meta, scenarioIndex });
  }
};

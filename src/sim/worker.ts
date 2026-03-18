import { join } from "path";
import { runSimulation } from "./engine.js";
import { ChunkWriter, scenarioDirName } from "../viz/writer.js";
import type { PricePoint, SimulationConfig, ScenarioMeta } from "../types.js";

declare var self: Worker;

let pricePoints: PricePoint[];

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;

  if (msg.type === "init") {
    pricePoints = msg.pricePoints;
    self.postMessage({ type: "ready" });
    return;
  }

  if (msg.type === "run") {
    const config: SimulationConfig = msg.config;
    const scenarioIndex: number = msg.scenarioIndex;
    const outputDir: string | undefined = msg.outputDir;

    const dirName = scenarioDirName(config.label, scenarioIndex);
    let writer: ChunkWriter | undefined;
    if (outputDir) {
      writer = new ChunkWriter(join(outputDir, dirName));
    }

    const onProgress = (pct: number) => {
      self.postMessage({ type: "progress", pct, scenarioIndex });
    };

    const result = runSimulation(config, pricePoints, writer?.sink, true, onProgress);

    let meta: ScenarioMeta | undefined;
    if (writer) {
      const info = writer.finish();
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

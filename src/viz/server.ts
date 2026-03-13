import { join } from "path";
import type {
  SimDataIndex,
  ScenarioMeta,
  BlockChunk,
  ApiMetaResponse,
  ApiDataResponse,
} from "../types.js";
import { aggregateOHLC, aggregateLine, aggregateDeviation } from "./aggregation.js";
import { loadIndex, loadChunk } from "./writer.js";

const TEMPLATE_PATH = join(import.meta.dir, "template.html");
const MAX_CANDLES = 10_000;
const OVER_FETCH_RATIO = 0.1;

const TIMEFRAMES = [6, 60, 900, 3600, 21600, 43200, 86400, 604800];

function nextTF(tf: number): number {
  for (const t of TIMEFRAMES) {
    if (t > tf) return t;
  }
  return TIMEFRAMES[TIMEFRAMES.length - 1];
}

function buildMetaResponse(index: SimDataIndex, filterIndices?: number[]): ApiMetaResponse {
  const indices = filterIndices ?? index.scenarios.map((_, i) => i);
  return {
    scenarioCount: indices.length,
    scenarios: indices.map((i) => ({
      index: i,
      config: index.scenarios[i].config,
      summary: index.scenarios[i].summary,
      timeRange: index.scenarios[i].timeRange,
      blockCount: index.scenarios[i].blockCount,
    })),
  };
}

/**
 * Load and concatenate the chunks that overlap [from, to] for a given scenario.
 */
async function loadScenarioRange(
  outputDir: string,
  scenarioIndex: number,
  meta: ScenarioMeta,
  from: number,
  to: number
): Promise<{ timestamps: number[]; realPrices: number[]; oraclePrices: number[]; deviationPcts: number[] }> {
  const timestamps: number[] = [];
  const realPrices: number[] = [];
  const oraclePrices: number[] = [];
  const deviationPcts: number[] = [];

  for (let c = 0; c < meta.chunkCount; c++) {
    const chunk = await loadChunk(outputDir, scenarioIndex, c);

    // Skip chunks entirely outside the range
    const chunkFrom = chunk.timestamps[0];
    const chunkTo = chunk.timestamps[chunk.timestamps.length - 1];
    if (chunkTo < from || chunkFrom > to) continue;

    // Append the relevant portion
    for (let i = 0; i < chunk.blockCount; i++) {
      const t = chunk.timestamps[i];
      if (t < from) continue;
      if (t > to) break;
      timestamps.push(t);
      realPrices.push(chunk.realPrices[i]);
      oraclePrices.push(chunk.oraclePrices[i]);
      deviationPcts.push(chunk.deviationPcts[i]);
    }
  }

  return { timestamps, realPrices, oraclePrices, deviationPcts };
}

async function buildDataResponse(
  outputDir: string,
  index: SimDataIndex,
  from: number,
  to: number,
  tf: number,
  scenarioFilter: string,
  allowedIndices?: number[],
): Promise<ApiDataResponse> {
  const requestedTF = tf;

  // Add over-fetch padding
  const span = to - from;
  const pad = span * OVER_FETCH_RATIO;
  const paddedFrom = from - pad;
  const paddedTo = to + pad;

  // Auto-upgrade TF if too many candles
  const windowSpan = paddedTo - paddedFrom;
  while (windowSpan / tf > MAX_CANDLES && tf < TIMEFRAMES[TIMEFRAMES.length - 1]) {
    tf = nextTF(tf);
  }

  // Determine which scenarios to include
  let scenarioIndices: number[];
  if (scenarioFilter === "all") {
    scenarioIndices = allowedIndices ?? index.scenarios.map((_, i) => i);
  } else {
    const idx = parseInt(scenarioFilter);
    if (!isNaN(idx) && (!allowedIndices || allowedIndices.includes(idx))) {
      scenarioIndices = [idx];
    } else {
      scenarioIndices = allowedIndices ?? index.scenarios.map((_, i) => i);
    }
  }

  // Load real price from first available scenario
  const firstIdx = scenarioIndices[0];
  const firstData = await loadScenarioRange(outputDir, firstIdx, index.scenarios[firstIdx], paddedFrom, paddedTo);
  const realOhlc = aggregateOHLC(firstData.timestamps, firstData.realPrices, paddedFrom, paddedTo, tf);
  const realLine = aggregateLine(firstData.timestamps, firstData.realPrices, paddedFrom, paddedTo, tf);

  const oracles = await Promise.all(scenarioIndices.map(async (idx) => {
    const data = idx === firstIdx
      ? firstData
      : await loadScenarioRange(outputDir, idx, index.scenarios[idx], paddedFrom, paddedTo);
    return {
      index: idx,
      label: index.scenarios[idx].config.label,
      ohlc: aggregateOHLC(data.timestamps, data.oraclePrices, paddedFrom, paddedTo, tf),
      line: aggregateLine(data.timestamps, data.oraclePrices, paddedFrom, paddedTo, tf),
      deviation: aggregateDeviation(data.timestamps, data.deviationPcts, paddedFrom, paddedTo, tf),
    };
  }));

  return {
    tf,
    requestedTF,
    from: paddedFrom,
    to: paddedTo,
    realPrice: { ohlc: realOhlc, line: realLine },
    oracles,
  };
}

export async function startServer(
  outputDir: string,
  port: number,
  openBrowser: boolean,
  filterIndices?: number[],
): Promise<void> {
  const index = await loadIndex(outputDir);
  const templateHtml = await Bun.file(TEMPLATE_PATH).text();
  const metaResponse = JSON.stringify(buildMetaResponse(index, filterIndices));

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/") {
        return new Response(templateHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/api/meta") {
        return new Response(metaResponse, {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      if (url.pathname === "/api/data") {
        const scenario = url.searchParams.get("scenario") ?? "all";
        const from = parseFloat(url.searchParams.get("from") ?? "0");
        const to = parseFloat(url.searchParams.get("to") ?? String(Date.now() / 1000));
        const tf = parseInt(url.searchParams.get("tf") ?? "900");

        if (isNaN(from) || isNaN(to) || isNaN(tf)) {
          return new Response(JSON.stringify({ error: "Invalid parameters" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const result = await buildDataResponse(outputDir, index, from, to, tf, scenario, filterIndices);
        return new Response(JSON.stringify(result), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const url = `http://localhost:${server.port}`;
  console.log(`Server running at ${url}`);

  if (openBrowser) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  }

  console.log("Press Ctrl+C to stop the server.");

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      console.log("\nStopping server...");
      server.stop();
      resolve();
    });
    process.on("SIGTERM", () => {
      server.stop();
      resolve();
    });
  });
}

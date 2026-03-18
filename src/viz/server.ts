import { join } from "path";
import { existsSync } from "fs";
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
const CHUNK_CACHE_MAX = 60;

const TIMEFRAMES = [6, 60, 900, 3600, 21600, 43200, 86400, 604800];

function nextTF(tf: number): number {
  for (const t of TIMEFRAMES) {
    if (t > tf) return t;
  }
  return TIMEFRAMES[TIMEFRAMES.length - 1];
}

// ── LRU chunk cache ──

const chunkCache = new Map<string, BlockChunk>();

async function loadChunkCached(outputDir: string, scenarioDir: string, chunkIndex: number): Promise<BlockChunk> {
  const key = `${scenarioDir}:${chunkIndex}`;
  const cached = chunkCache.get(key);
  if (cached) {
    chunkCache.delete(key);
    chunkCache.set(key, cached);
    return cached;
  }
  const chunk = await loadChunk(outputDir, scenarioDir, chunkIndex);
  chunkCache.set(key, chunk);
  if (chunkCache.size > CHUNK_CACHE_MAX) {
    const firstKey = chunkCache.keys().next().value;
    if (firstKey !== undefined) chunkCache.delete(firstKey);
  }
  return chunk;
}

// ── Helpers ──

function scenarioDir(meta: ScenarioMeta, index: number): string {
  return meta.dir ?? `scenario_${index}`;
}

function buildMetaResponse(
  index: SimDataIndex,
  filterIndices?: number[],
  timeConstraint?: { from: number; to: number },
): ApiMetaResponse {
  const indices = filterIndices ?? index.scenarios.map((_, i) => i);
  return {
    scenarioCount: indices.length,
    scenarios: indices.map((i) => {
      const sc = index.scenarios[i];
      let tr = sc.timeRange;
      if (timeConstraint) {
        tr = {
          from: Math.max(tr.from, timeConstraint.from),
          to: Math.min(tr.to, timeConstraint.to),
        };
      }
      return {
        index: i,
        config: sc.config,
        summary: sc.summary,
        timeRange: tr,
        blockCount: sc.blockCount,
      };
    }),
  };
}

async function loadScenarioRange(
  outputDir: string,
  scenarioIndex: number,
  meta: ScenarioMeta,
  from: number,
  to: number,
): Promise<{ timestamps: number[]; realPrices: number[]; oraclePrices: number[]; deviationPcts: number[] }> {
  const timestamps: number[] = [];
  const realPrices: number[] = [];
  const oraclePrices: number[] = [];
  const deviationPcts: number[] = [];
  const dir = scenarioDir(meta, scenarioIndex);

  for (let c = 0; c < meta.chunkCount; c++) {
    // Fast skip via chunk time ranges stored in index (avoids loading chunk from disk)
    if (meta.chunkTimeRanges && meta.chunkTimeRanges[c]) {
      const cr = meta.chunkTimeRanges[c];
      if (cr.to < from || cr.from > to) continue;
    }

    const chunk = await loadChunkCached(outputDir, dir, c);

    const chunkFrom = chunk.timestamps[0];
    const chunkTo = chunk.timestamps[chunk.timestamps.length - 1];
    if (chunkTo < from || chunkFrom > to) continue;

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

function parseScenarioFilter(raw: string, allowedIndices?: number[]): number[] | "all" {
  if (raw === "all") return "all";
  const indices = raw.split(",").map(Number).filter((n) => !isNaN(n));
  if (indices.length === 0) return "all";
  if (allowedIndices) return indices.filter((i) => allowedIndices.includes(i));
  return indices;
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

  const span = to - from;
  const pad = span * OVER_FETCH_RATIO;
  const paddedFrom = from - pad;
  const paddedTo = to + pad;

  const windowSpan = paddedTo - paddedFrom;
  while (windowSpan / tf > MAX_CANDLES && tf < TIMEFRAMES[TIMEFRAMES.length - 1]) {
    tf = nextTF(tf);
  }

  const parsed = parseScenarioFilter(scenarioFilter, allowedIndices);
  let scenarioIndices: number[];
  if (parsed === "all") {
    scenarioIndices = allowedIndices ?? index.scenarios.map((_, i) => i);
  } else {
    scenarioIndices = parsed.length > 0 ? parsed : (allowedIndices ?? index.scenarios.map((_, i) => i));
  }

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
  timeConstraint?: { from: number; to: number },
): Promise<void> {
  const index = await loadIndex(outputDir);
  const templateHtml = await Bun.file(TEMPLATE_PATH).text();
  const metaResponse = JSON.stringify(buildMetaResponse(index, filterIndices, timeConstraint));

  const reportPath = join(outputDir, "research_report.json");
  const researchJson = existsSync(reportPath) ? await Bun.file(reportPath).text() : null;

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

      if (url.pathname === "/api/research") {
        if (!researchJson) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(researchJson, {
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

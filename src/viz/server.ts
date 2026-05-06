import { join } from "path";
import { existsSync } from "fs";
import type {
  SimDataIndex,
  ScenarioMeta,
  BlockChunk,
  ApiMetaResponse,
  ApiDataResponse,
  LinePoint,
  ValidatorGroup,
  ValidatorType,
} from "../types.js";
import { aggregateOHLC, aggregateLine, aggregateDeviation } from "./aggregation.js";
import { loadIndex, loadChunk, loadVenues, type VenuesFile } from "./writer.js";
import { mulberry32 } from "../rng.js";
import { BLOCK_TIME_SECONDS } from "../config.js";

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

// ── Author replay (per-scenario cache) ──────────────────────────────────────
// Author selection in chain.ts is `Math.floor(rng() * validators.length)`,
// where the chain's only RNG consumer is author selection. So we can rebuild
// the entire authorIndex sequence by replaying mulberry32(seed) blockCount
// times — no need to write authors to .simdata.
//
// Cache key: scenario directory name (unique per scenario in the index).
// Memory: 4 bytes × blockCount per scenario; 5M blocks ≈ 20 MB. The cache is
// uncapped because `--data` only ever serves one .simdata directory at a time.
const authorCache = new Map<string, Uint32Array>();

function totalValidatorCount(validators: ValidatorGroup[]): number {
  let n = 0;
  for (const g of validators) n += g.count;
  return n;
}

function getAuthorIndices(meta: ScenarioMeta, scenarioIdx: number): Uint32Array {
  const key = scenarioDir(meta, scenarioIdx);
  const cached = authorCache.get(key);
  if (cached) return cached;
  const total = totalValidatorCount(meta.config.validators);
  const arr = new Uint32Array(meta.blockCount);
  if (total > 0) {
    const rng = mulberry32(meta.config.seed);
    for (let i = 0; i < meta.blockCount; i++) {
      arr[i] = Math.floor(rng() * total);
    }
  }
  authorCache.set(key, arr);
  return arr;
}

/** Walk the validator groups (which are stored in order) to find the type
 *  that owns `authorIdx`. O(groups), groups is tiny (<10 typical). */
function validatorTypeAt(validators: ValidatorGroup[], authorIdx: number): ValidatorType {
  let cum = 0;
  for (const g of validators) {
    if (authorIdx < cum + g.count) return g.type;
    cum += g.count;
  }
  // Fallback for out-of-range; shouldn't happen unless authorIdx ≥ total.
  return validators.length > 0 ? validators[validators.length - 1].type : "honest";
}

/** Floor a timestamp to the block index using uniform 6s spacing from
 *  meta.timeRange.from. Clamps to [0, blockCount-1]. */
function blockAtTimestamp(meta: ScenarioMeta, ts: number): number {
  if (meta.blockCount === 0) return 0;
  if (ts <= meta.timeRange.from) return 0;
  if (ts >= meta.timeRange.to) return meta.blockCount - 1;
  const idx = Math.floor((ts - meta.timeRange.from) / BLOCK_TIME_SECONDS);
  return Math.max(0, Math.min(meta.blockCount - 1, idx));
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
  venues: VenuesFile | null,
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

  let venuesResp: Record<string, LinePoint[]> | undefined;
  if (venues) {
    venuesResp = {};
    for (const [vid, prices] of Object.entries(venues.venues)) {
      venuesResp[vid] = aggregateLine(venues.timestamps, prices, paddedFrom, paddedTo, tf);
    }
  }

  return {
    tf,
    requestedTF,
    from: paddedFrom,
    to: paddedTo,
    realPrice: { ohlc: realOhlc, line: realLine },
    oracles,
    venues: venuesResp,
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
  const venues = await loadVenues(outputDir);
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

      if (url.pathname === "/api/block") {
        // Hover-tooltip lookup: which block was authored by whom at this time,
        // for which scenarios. Lightweight; cache makes it O(1) post-warmup.
        const scenarioParam = url.searchParams.get("scenarios") ?? "all";
        const time = parseFloat(url.searchParams.get("time") ?? "0");
        if (isNaN(time)) {
          return new Response(JSON.stringify({ error: "Invalid time" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const parsed = parseScenarioFilter(scenarioParam, filterIndices);
        const allowed = filterIndices ?? index.scenarios.map((_, i) => i);
        const scenarioIndices = parsed === "all" ? allowed : (parsed.length > 0 ? parsed : allowed);

        if (scenarioIndices.length === 0) {
          return new Response(JSON.stringify({ block: 0, timestamp: time, authors: [] }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        // All scenarios share the same block timeline (driven by the price
        // source, not the validator config), so resolve block from the first.
        const refMeta = index.scenarios[scenarioIndices[0]];
        const block = blockAtTimestamp(refMeta, time);
        const blockTimestamp = refMeta.timeRange.from + block * BLOCK_TIME_SECONDS;

        const authors = scenarioIndices.map((idx) => {
          const meta = index.scenarios[idx];
          const arr = getAuthorIndices(meta, idx);
          // Clamp in case scenarios disagree on blockCount (shouldn't happen).
          const safeBlock = Math.min(block, arr.length - 1);
          const authorIdx = arr[safeBlock] ?? 0;
          const type = validatorTypeAt(meta.config.validators, authorIdx);
          return { scenario: idx, label: meta.config.label, index: authorIdx, type };
        });

        return new Response(JSON.stringify({ block, timestamp: blockTimestamp, authors }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
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

        const result = await buildDataResponse(outputDir, index, venues, from, to, tf, scenario, filterIndices);
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

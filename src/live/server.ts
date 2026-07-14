import { join } from "path";
import type { SimulationConfig, SimulationSummary, VenueId, LinePoint } from "../types.js";
import { aggregateOHLC, aggregateLine, aggregateDeviation } from "../viz/aggregation.js";
import type { LiveStore } from "./store.js";
import type { VenueStatus } from "./types.js";

const TEMPLATE_PATH = join(import.meta.dir, "..", "viz", "template.html");
const BLOCK_TEMPLATE_PATH = join(import.meta.dir, "..", "viz", "block.html");
const MAX_CANDLES = 10_000;
const OVER_FETCH_RATIO = 0.1;
const TIMEFRAMES = [6, 60, 900, 3600, 21600, 43200, 86400, 604800];

function nextTF(tf: number): number {
  for (const t of TIMEFRAMES) {
    if (t > tf) return t;
  }
  return TIMEFRAMES[TIMEFRAMES.length - 1];
}

export interface LiveServerContext {
  store: LiveStore;
  config: SimulationConfig;
  venues: VenueId[];
  validators: Array<{ index: number; venues: VenueId[] }>;
  feedStatus: () => Record<string, VenueStatus>;
}

function buildSummary(ctx: LiveServerContext): SimulationSummary {
  const s = ctx.store.summaryStats();
  return {
    totalBlocks: ctx.store.blockCount,
    aggregator: "latched-median",
    epsilon: 0,
    epsilonMode: "abs",
    convergenceThreshold: ctx.config.convergenceThreshold,
    convergenceRate: s.convergenceRate,
    meanDeviation: s.meanDeviation,
    meanDeviationPct: s.meanDeviationPct,
    maxDeviation: s.maxDeviation,
    maxDeviationPct: s.maxDeviationPct,
    deviationIntegral: 0,
    maxDeviationRate: 0,
    maxConsecutiveBlocksAboveThreshold: 0,
    p95DeviationPct: s.p95DeviationPct,
    p99DeviationPct: s.p99DeviationPct,
  };
}

function buildMeta(ctx: LiveServerContext): unknown {
  const { store } = ctx;
  const from = store.timestamps[0] ?? Math.floor(Date.now() / 1000);
  const to = store.timestamps[store.timestamps.length - 1] ?? from;
  const endDate = new Date(to * 1000).toISOString().slice(0, 10);
  return {
    scenarioCount: 1,
    live: true,
    venueStatus: ctx.feedStatus(),
    scenarios: [{
      index: 0,
      config: { ...ctx.config, endDate },
      summary: buildSummary(ctx),
      timeRange: { from, to },
      blockCount: store.blockCount,
    }],
  };
}

function buildData(ctx: LiveServerContext, from: number, to: number, tf: number): unknown {
  const { store } = ctx;
  const requestedTF = tf;
  const span = to - from;
  const pad = span * OVER_FETCH_RATIO;
  const paddedFrom = from - pad;
  const paddedTo = to + pad;
  const windowSpan = paddedTo - paddedFrom;
  while (windowSpan / tf > MAX_CANDLES && tf < TIMEFRAMES[TIMEFRAMES.length - 1]) {
    tf = nextTF(tf);
  }

  const venuesResp: Record<string, LinePoint[]> = {};
  for (const [vid, prices] of Object.entries(store.venueSeries)) {
    venuesResp[vid] = aggregateLine(store.timestamps, prices, paddedFrom, paddedTo, tf);
  }

  return {
    tf,
    requestedTF,
    from: paddedFrom,
    to: paddedTo,
    realPrice: {
      ohlc: aggregateOHLC(store.timestamps, store.realPrices, paddedFrom, paddedTo, tf),
      line: aggregateLine(store.timestamps, store.realPrices, paddedFrom, paddedTo, tf),
    },
    oracles: [{
      index: 0,
      label: ctx.config.label,
      ohlc: aggregateOHLC(store.timestamps, store.oraclePrices, paddedFrom, paddedTo, tf),
      line: aggregateLine(store.timestamps, store.oraclePrices, paddedFrom, paddedTo, tf),
      deviation: aggregateDeviation(store.timestamps, store.deviationPcts, paddedFrom, paddedTo, tf),
    }],
    venues: venuesResp,
  };
}

function buildBlockTooltip(ctx: LiveServerContext, time: number): unknown {
  const { store } = ctx;
  const block = store.blockAtTimestamp(time);
  const rec = store.recordAt(block);
  if (!rec) return { block: 0, timestamp: time, authors: [], event: null };
  return {
    block,
    timestamp: rec.timestamp,
    event: null,
    authors: [{
      scenario: 0,
      label: ctx.config.label,
      index: rec.authorIndex,
      type: "honest",
      priceUpdated: rec.priceUpdated,
      inherentTotal: rec.inherentTotal,
      medianValidatorType: rec.medianValidatorIndex !== null ? "honest" : null,
      agreementRate: null,
      epsilonCoefficient: null,
    }],
  };
}

function buildBlockDetail(ctx: LiveServerContext, block: number): unknown {
  const { store } = ctx;
  const rec = store.recordAt(block);
  if (!rec) {
    return {
      scenario: 0, label: ctx.config.label, block, timestamp: 0, found: false,
      author: null, prevPrice: null, newPrice: null, realPrice: null,
      priceUpdated: null, inherentTotal: null, inherentNonHonest: null,
      medianValidator: null, agreementRate: null, epsilonCoefficient: null, votes: [],
    };
  }
  const traces = store.tracesFor(block);
  const liveValidators = rec.submissions.map((s) => ({
    index: s.validatorIndex,
    price: s.price,
    venues: s.venues,
    used: s.used,
    droppedStale: s.droppedStale,
    droppedVolume: s.droppedVolume,
    droppedMad: s.droppedMad,
    isAuthor: s.validatorIndex === rec.authorIndex,
    isMedian: s.validatorIndex === rec.medianValidatorIndex,
    trace: traces?.get(s.validatorIndex) ?? null,
  }));
  return {
    scenario: 0,
    label: ctx.config.label,
    block,
    timestamp: rec.timestamp,
    found: true,
    author: { index: rec.authorIndex, type: "honest", isHonest: true },
    prevPrice: rec.prevOraclePrice,
    newPrice: rec.oraclePrice,
    realPrice: rec.realPrice,
    priceUpdated: rec.priceUpdated,
    inherentTotal: rec.inherentTotal,
    inherentNonHonest: 0,
    medianValidator: rec.medianValidatorIndex !== null
      ? { index: rec.medianValidatorIndex, type: "honest" }
      : null,
    agreementRate: null,
    epsilonCoefficient: null,
    votes: rec.submissions
      .filter((s) => s.price !== null)
      .map((s) => ({ kind: "quote", type: "honest", price: s.price })),
    live: {
      validators: liveValidators,
      venueStatus: rec.venueStatus,
      venuePrices: rec.venuePrices,
    },
  };
}

const JSON_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

export function startLiveServer(
  ctx: LiveServerContext,
  port: number,
  openBrowser: boolean,
): void {
  const templateHtml = Bun.file(TEMPLATE_PATH);
  const blockHtml = Bun.file(BLOCK_TEMPLATE_PATH);

  const server = Bun.serve({
    port,
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/") {
        return new Response(await templateHtml.text(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/block") {
        return new Response(await blockHtml.text(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/api/meta") {
        return new Response(JSON.stringify(buildMeta(ctx)), { headers: JSON_HEADERS });
      }
      if (url.pathname === "/api/data") {
        const from = parseFloat(url.searchParams.get("from") ?? "0");
        const to = parseFloat(url.searchParams.get("to") ?? String(Date.now() / 1000));
        const tf = parseInt(url.searchParams.get("tf") ?? "6", 10);
        if (isNaN(from) || isNaN(to) || isNaN(tf)) {
          return new Response(JSON.stringify({ error: "Invalid parameters" }), { status: 400, headers: JSON_HEADERS });
        }
        return new Response(JSON.stringify(buildData(ctx, from, to, tf)), { headers: JSON_HEADERS });
      }
      if (url.pathname === "/api/block") {
        const time = parseFloat(url.searchParams.get("time") ?? "0");
        if (isNaN(time)) {
          return new Response(JSON.stringify({ error: "Invalid time" }), { status: 400, headers: JSON_HEADERS });
        }
        return new Response(JSON.stringify(buildBlockTooltip(ctx, time)), { headers: JSON_HEADERS });
      }
      if (url.pathname === "/api/block-detail") {
        const blockParam = url.searchParams.get("block");
        const timeParam = url.searchParams.get("time");
        let block: number;
        if (blockParam !== null && !isNaN(parseInt(blockParam, 10))) {
          block = Math.max(0, Math.min(ctx.store.blockCount - 1, parseInt(blockParam, 10)));
        } else {
          const time = parseFloat(timeParam ?? "");
          if (isNaN(time)) {
            return new Response(JSON.stringify({ error: "Invalid time/block" }), { status: 400, headers: JSON_HEADERS });
          }
          block = ctx.store.blockAtTimestamp(time);
        }
        return new Response(JSON.stringify(buildBlockDetail(ctx, block)), { headers: JSON_HEADERS });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  const url = `http://localhost:${server.port}`;
  console.log(`\n  Live chart server running at ${url}`);
  if (openBrowser) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  }
}

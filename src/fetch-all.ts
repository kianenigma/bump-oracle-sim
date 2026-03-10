/**
 * Downloads the entire DOT/USDT 1m candle history available on Binance
 * into the consolidated cache. Discovers the earliest available candle
 * automatically, then fetches everything up to now.
 *
 * Usage: bun run src/fetch-all.ts
 */

import { BINANCE_BASE_URL, BINANCE_BATCH_LIMIT, CANDLE_INTERVAL_MS } from "./config.js";
import type { Candle } from "./types.js";
import { loadCache, saveCache, mergeCandles, type ConsolidatedCache } from "./data/cache.js";

const SYMBOL = "DOTUSDT";
const INTERVAL = "1m";

async function fetchBatch(startMs: number, endMs: number): Promise<Candle[]> {
  const url = new URL(BINANCE_BASE_URL);
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", INTERVAL);
  url.searchParams.set("startTime", String(startMs));
  url.searchParams.set("endTime", String(endMs));
  url.searchParams.set("limit", String(BINANCE_BATCH_LIMIT));

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = (await res.json()) as number[][];
      return data.map((c) => ({
        timestamp: Math.floor(c[0] / 1000),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5]),
      }));
    } catch (e) {
      if (attempt < 2) {
        const wait = 2 ** attempt * 1000;
        console.log(`  Retry ${attempt + 1}/3 after ${wait}ms: ${e}`);
        await Bun.sleep(wait);
      } else {
        throw e;
      }
    }
  }
  return [];
}

/** Find the earliest available candle by requesting from epoch. */
async function findEarliestCandle(): Promise<number> {
  console.log("Discovering earliest available DOT/USDT candle...");
  const candles = await fetchBatch(0, Date.now());
  if (candles.length === 0) {
    throw new Error("No DOT/USDT data found on Binance");
  }
  const earliest = candles[0].timestamp * 1000;
  console.log(`  Earliest: ${new Date(earliest).toISOString()}`);
  return earliest;
}

async function main() {
  const cache: ConsolidatedCache = (await loadCache()) ?? {
    asset: "DOT",
    quote: "USDT",
    interval: INTERVAL,
    source: "binance",
    dataPoints: 0,
    data: [],
  };

  const earliestMs = await findEarliestCandle();
  const nowMs = Date.now();

  // Determine what we already have
  let fetchFromMs: number;
  let fetchToMs: number;

  if (cache.data.length === 0) {
    fetchFromMs = earliestMs;
    fetchToMs = nowMs;
    console.log(`Cache is empty — fetching full history`);
  } else {
    const minCached = cache.data[0].timestamp * 1000;
    const maxCached = cache.data[cache.data.length - 1].timestamp * 1000;
    console.log(`Cache has ${cache.data.length} candles: ${new Date(minCached).toISOString()} to ${new Date(maxCached).toISOString()}`);

    // We only need to extend forward (suffix), since the earliest data is fixed
    if (maxCached + CANDLE_INTERVAL_MS >= nowMs) {
      console.log("Cache is already up to date!");
      return;
    }
    fetchFromMs = maxCached + CANDLE_INTERVAL_MS;
    fetchToMs = nowMs;

    // Also check if we're missing the beginning
    if (minCached > earliestMs + CANDLE_INTERVAL_MS) {
      console.log(`Also fetching prefix: ${new Date(earliestMs).toISOString()} to ${new Date(minCached).toISOString()}`);
      const prefixCandles = await fetchRange(earliestMs, minCached - CANDLE_INTERVAL_MS);
      if (prefixCandles.length > 0) {
        cache.data = mergeCandles(cache.data, prefixCandles);
        console.log(`  Merged ${prefixCandles.length} prefix candles`);
      }
    }
  }

  console.log(`Fetching: ${new Date(fetchFromMs).toISOString()} to ${new Date(fetchToMs).toISOString()}`);
  const expectedCandles = Math.floor((fetchToMs - fetchFromMs) / CANDLE_INTERVAL_MS);
  console.log(`  Expected: ~${expectedCandles.toLocaleString()} candles`);

  const newCandles = await fetchRange(fetchFromMs, fetchToMs);
  if (newCandles.length > 0) {
    cache.data = mergeCandles(cache.data, newCandles);
  }

  await saveCache(cache);

  const minTs = cache.data[0].timestamp;
  const maxTs = cache.data[cache.data.length - 1].timestamp;
  console.log(`\nDone! Cache now has ${cache.data.length.toLocaleString()} candles`);
  console.log(`  Range: ${new Date(minTs * 1000).toISOString()} to ${new Date(maxTs * 1000).toISOString()}`);
}

async function fetchRange(startMs: number, endMs: number): Promise<Candle[]> {
  const expectedCandles = Math.floor((endMs - startMs) / CANDLE_INTERVAL_MS);
  const totalBatches = Math.ceil(expectedCandles / BINANCE_BATCH_LIMIT);
  const allCandles: Candle[] = [];
  let currentStart = startMs;
  let batch = 0;

  while (currentStart < endMs) {
    batch++;
    const candles = await fetchBatch(currentStart, endMs);
    if (candles.length === 0) break;

    allCandles.push(...candles);
    if (batch % 50 === 0 || batch === totalBatches) {
      const pct = ((batch / totalBatches) * 100).toFixed(1);
      console.log(`  Batch ${batch}/${totalBatches} (${pct}%) — ${allCandles.length.toLocaleString()} candles`);
    }

    currentStart = candles[candles.length - 1].timestamp * 1000 + CANDLE_INTERVAL_MS;
    await Bun.sleep(200);
  }

  // Deduplicate
  const seen = new Set<number>();
  return allCandles.filter((c) => {
    if (seen.has(c.timestamp)) return false;
    seen.add(c.timestamp);
    return true;
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

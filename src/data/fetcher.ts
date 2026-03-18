import { BINANCE_BASE_URL, BINANCE_BATCH_LIMIT, CANDLE_INTERVAL_MS } from "../config.js";
import type { Candle, CacheMetadata } from "../types.js";
import { loadCache, saveCache, sliceRange, mergeCandles, type ConsolidatedCache } from "./cache.js";

async function fetchBatch(
  symbol: string,
  interval: string,
  startMs: number,
  endMs: number
): Promise<Candle[]> {
  const url = new URL(BINANCE_BASE_URL);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
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
  return []; // unreachable
}

/** Fetch a contiguous range [startMs, endMs) from Binance in batches. */
async function fetchRange(startMs: number, endMs: number, interval: string): Promise<Candle[]> {
  const expectedCandles = Math.floor((endMs - startMs) / CANDLE_INTERVAL_MS);
  const totalBatches = Math.ceil(expectedCandles / BINANCE_BATCH_LIMIT);
  const allCandles: Candle[] = [];
  let currentStart = startMs;
  let batch = 0;

  while (currentStart < endMs) {
    batch++;
    const candles = await fetchBatch("DOTUSDT", interval, currentStart, endMs);
    if (candles.length === 0) break;

    allCandles.push(...candles);
    console.log(`  Batch ${batch}/${totalBatches}: ${candles.length} candles`);

    currentStart = candles[candles.length - 1].timestamp * 1000 + CANDLE_INTERVAL_MS;
    await Bun.sleep(200);
  }

  return allCandles;
}

export async function fetchCandles(
  startDate: string,
  endDate: string,
  interval: string = "1m"
): Promise<CacheMetadata> {
  const fromTs = Math.floor(new Date(startDate + "T00:00:00Z").getTime() / 1000);
  const toTs = Math.floor(new Date(endDate + "T00:00:00Z").getTime() / 1000);

  // Load consolidated cache
  let cache: ConsolidatedCache = (await loadCache()) ?? {
    asset: "DOT",
    quote: "USDT",
    interval,
    source: "binance",
    dataPoints: 0,
    data: [],
  };

  // Find what's already cached in [fromTs, toTs]
  const cached = sliceRange(cache, fromTs, toTs);
  const gaps: Array<{ fromMs: number; toMs: number; label: string }> = [];

  if (cached.length === 0) {
    // Nothing cached in this range — fetch it all
    gaps.push({ fromMs: fromTs * 1000, toMs: toTs * 1000, label: "full range" });
  } else {
    const minCached = cached[0].timestamp;
    const maxCached = cached[cached.length - 1].timestamp;

    // Prefix gap: [fromTs, minCached - 60s]
    if (fromTs < minCached) {
      gaps.push({
        fromMs: fromTs * 1000,
        toMs: (minCached - 60) * 1000,
        label: "prefix",
      });
    }

    // Suffix gap: [maxCached + 60s, toTs]
    if (toTs > maxCached) {
      gaps.push({
        fromMs: (maxCached + 60) * 1000,
        toMs: toTs * 1000,
        label: "suffix",
      });
    }
  }

  if (gaps.length === 0) {
    console.log(`Using cached data (${cached.length} candles in range)`);
  } else {
    console.log(
      `Fetching DOT/USDT from Binance (${gaps.map((g) => g.label).join(" + ")})...`
    );
    console.log(`  Interval: ${interval}`);
    console.log(`  Range: ${startDate} to ${endDate}`);
    if (cached.length > 0) {
      console.log(`  Already cached: ${cached.length} candles`);
    }

    let newCandles: Candle[] = [];
    for (const gap of gaps) {
      console.log(`  Fetching ${gap.label}: ${new Date(gap.fromMs).toISOString()} -> ${new Date(gap.toMs).toISOString()}`);
      const fetched = await fetchRange(gap.fromMs, gap.toMs, interval);
      if (fetched.length === 0) {
        console.log(`  Warning: no data returned for ${gap.label} (data may not be available on Binance for this period)`);
      }
      newCandles = newCandles.concat(fetched);
    }

    // Deduplicate incoming candles (fetchRange may have overlap at boundaries)
    newCandles.sort((a, b) => a.timestamp - b.timestamp);
    const seen = new Set<number>();
    const uniqueNew = newCandles.filter((c) => {
      if (seen.has(c.timestamp)) return false;
      seen.add(c.timestamp);
      return true;
    });

    // Merge into consolidated cache and save
    cache.data = mergeCandles(cache.data, uniqueNew);
    await saveCache(cache);

    console.log(`  Fetched ${uniqueNew.length} new candles, cache now has ${cache.data.length} total`);
  }

  // Return the slice for the requested range
  const result = sliceRange(cache, fromTs, toTs);
  return {
    asset: "DOT",
    quote: "USDT",
    interval,
    source: "binance",
    startDate,
    endDate,
    dataPoints: result.length,
    data: result,
  };
}

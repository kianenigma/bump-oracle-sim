import { join } from "path";
import type { Candle } from "../types.js";

const CACHE_DIR = join(import.meta.dir, "../../price-data");
const CACHE_PATH = join(CACHE_DIR, "dot_usdt_1m_cache.json");

export interface ConsolidatedCache {
  asset: string;
  quote: string;
  interval: string;
  source: string;
  dataPoints: number;
  data: Candle[]; // sorted by timestamp, deduplicated
}

export async function loadCache(): Promise<ConsolidatedCache | null> {
  const file = Bun.file(CACHE_PATH);
  if (await file.exists()) {
    return file.json() as Promise<ConsolidatedCache>;
  }
  return null;
}

export async function saveCache(cache: ConsolidatedCache): Promise<void> {
  const { mkdir } = await import("fs/promises");
  await mkdir(CACHE_DIR, { recursive: true });
  cache.dataPoints = cache.data.length;
  await Bun.write(CACHE_PATH, JSON.stringify(cache));
  console.log(`  Cache saved: ${cache.dataPoints} candles -> ${CACHE_PATH}`);
}

/** Binary search: first index where data[i].timestamp >= target */
function lowerBound(data: Candle[], target: number): number {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (data[mid].timestamp < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Binary search: first index where data[i].timestamp > target */
function upperBound(data: Candle[], target: number): number {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (data[mid].timestamp <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Extract candles within [fromTs, toTs] using binary search. */
export function sliceRange(cache: ConsolidatedCache, fromTs: number, toTs: number): Candle[] {
  const start = lowerBound(cache.data, fromTs);
  const end = upperBound(cache.data, toTs);
  return cache.data.slice(start, end);
}

/** Merge two sorted candle arrays, deduplicating by timestamp (single-pass). */
export function mergeCandles(existing: Candle[], incoming: Candle[]): Candle[] {
  const result: Candle[] = [];
  let i = 0;
  let j = 0;
  while (i < existing.length && j < incoming.length) {
    const a = existing[i];
    const b = incoming[j];
    if (a.timestamp < b.timestamp) {
      result.push(a);
      i++;
    } else if (a.timestamp > b.timestamp) {
      result.push(b);
      j++;
    } else {
      // Same timestamp — keep existing (or incoming, doesn't matter)
      result.push(a);
      i++;
      j++;
    }
  }
  while (i < existing.length) result.push(existing[i++]);
  while (j < incoming.length) result.push(incoming[j++]);
  return result;
}

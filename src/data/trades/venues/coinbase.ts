import type { VenueBucket, VenueSpotSource } from "../types.js";
import { BLOCKS_PER_DAY, BLOCK_TIME_SECONDS } from "../types.js";
import { dayStartSec } from "../aggregate.js";
import { readBucketCache, writeBucketCache } from "../cache.js";

// Coinbase Exchange spot data for DOT-USD.
//
// Implementation note: the per-trade endpoint
//   GET /products/DOT-USD/trades?limit=1000&after=<id>
// only supports cursor-based pagination (no time-range filter). Walking back
// from "now" to arbitrary historical dates costs O(trades_since_then) — for
// targets months in the past this is tens of thousands of API calls and
// hours of wall time. Coinbase's candles endpoint, however, accepts
// start/end timestamps directly:
//   GET /products/DOT-USD/candles?granularity=60&start=<iso>&end=<iso>
// Each call returns up to 300 candles → 5 calls cover a full UTC day at 1m
// resolution. We linearly interpolate each 1m candle into ten 6s buckets
// (open→close, volume split equally) to produce the same VenueBucket[]
// shape as the other venues. This trades intra-minute granularity for
// time-range usability — Coinbase Exchange doesn't expose finer-than-1m
// public data on historical ranges, so this is the best we can do without
// per-trade pagination.
//
// The downstream sim is unchanged: each 6s bucket has a vwap and a volume,
// and `combineVenues` treats Coinbase's reconstructed values exactly like
// any other venue's real VWAPs.

const PAIR = "DOT-USD";
const RULE = "vwap" as const;

const CANDLES_URL = "https://api.exchange.coinbase.com/products";
// 1m granularity, max 300 candles per call → 5 calls cover 24 h.
const GRANULARITY = 60;
const MAX_CANDLES_PER_CALL = 300;
const REST_DELAY_MS = 120;  // public-tier limit ~10 req/s; 120 ms is conservative.

interface CoinbaseCandle {
  startSec: number;   // candle open time, Unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;     // base-asset (DOT) volume during this 1m
}

/** Fetch all 1m candles for [startSec, endSec) via repeated calls. */
async function fetchCandlesRange(startSec: number, endSec: number): Promise<CoinbaseCandle[]> {
  const out: CoinbaseCandle[] = [];
  let cursor = startSec;
  let calls = 0;
  while (cursor < endSec && calls < 50) {
    const callEnd = Math.min(endSec, cursor + MAX_CANDLES_PER_CALL * GRANULARITY);
    const url = `${CANDLES_URL}/${PAIR}/candles?granularity=${GRANULARITY}&start=${new Date(cursor * 1000).toISOString()}&end=${new Date(callEnd * 1000).toISOString()}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Coinbase: ${url} failed with ${res.status} ${res.statusText}`);
    }
    const arr = (await res.json()) as Array<[number, number, number, number, number, number]>;
    // Coinbase returns candles in DESCENDING order (newest first). Append all
    // and sort once at the end; only retain candles strictly inside the range.
    for (const c of arr) {
      const [t, low, high, open, close, volume] = c;
      if (t < startSec || t >= endSec) continue;
      out.push({ startSec: t, open, high, low, close, volume });
    }
    cursor = callEnd;
    calls++;
    if (cursor < endSec) await sleep(REST_DELAY_MS);
  }
  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}

/** Convert minute candles to 6s VenueBuckets by linearly interpolating
 *  open → close across the 10 sub-buckets and splitting volume evenly. */
function candlesToBuckets(candles: CoinbaseCandle[], dayStart: number): VenueBucket[] {
  const buckets: VenueBucket[] = new Array(BLOCKS_PER_DAY);
  for (let i = 0; i < BLOCKS_PER_DAY; i++) {
    buckets[i] = { blockTimestamp: dayStart + i * BLOCK_TIME_SECONDS, vwap: null, tradeCount: 0, volume: 0 };
  }
  const subBucketsPerMinute = 60 / BLOCK_TIME_SECONDS;  // 10
  for (const c of candles) {
    const minuteIdx = Math.floor((c.startSec - dayStart) / 60);
    if (minuteIdx < 0 || minuteIdx >= BLOCKS_PER_DAY / subBucketsPerMinute) continue;
    const baseIdx = minuteIdx * subBucketsPerMinute;
    const volPerSub = c.volume / subBucketsPerMinute;
    for (let s = 0; s < subBucketsPerMinute; s++) {
      // Linear interp from open at s=0 to close at s=9. Matches the existing
      // candle-mode interpolation in src/data/interpolator.ts.
      const t = subBucketsPerMinute === 1 ? 0 : s / (subBucketsPerMinute - 1);
      const price = c.open + (c.close - c.open) * t;
      buckets[baseIdx + s] = {
        blockTimestamp: dayStart + (baseIdx + s) * BLOCK_TIME_SECONDS,
        vwap: price,
        tradeCount: 0,                  // not available from candle endpoint
        volume: volPerSub,
      };
    }
  }
  return buckets;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class CoinbaseSpotSource implements VenueSpotSource {
  readonly id = "coinbase" as const;
  readonly pair = PAIR;

  async loadDay(date: string): Promise<VenueBucket[]> {
    const cached = await readBucketCache(this.id, this.pair, date, RULE);
    if (cached) return cached;

    const startSec = dayStartSec(date);
    const endSec = startSec + 86400;
    console.log(`  [coinbase ${date}] fetching 1m candles (${PAIR}) for ${date} (UTC)`);

    const candles = await fetchCandlesRange(startSec, endSec);
    console.log(`  [coinbase ${date}] ${candles.length} 1m candles → expanding to 6s buckets`);

    const buckets = candlesToBuckets(candles, startSec);
    if (buckets.length !== BLOCKS_PER_DAY) {
      throw new Error(`coinbase: expected ${BLOCKS_PER_DAY} buckets, got ${buckets.length}`);
    }
    const populated = buckets.reduce((n, b) => n + (b.vwap !== null ? 1 : 0), 0);
    console.log(`  [coinbase ${date}] ${populated}/${BLOCKS_PER_DAY} populated buckets`);
    if (populated === 0 && candles.length > 0) {
      throw new Error(
        `Coinbase: ${candles.length} candles fetched but 0 buckets populated for ${date}. ` +
        `Likely a date-alignment bug; inspect candle timestamps.`
      );
    }
    await writeBucketCache(this.id, this.pair, date, RULE, buckets);
    return buckets;
  }
}

import type { VenueBucket, VenueSpotSource, RawTrade } from "../types.js";
import { BLOCKS_PER_DAY } from "../types.js";
import { bucketizeDay, dayStartSec } from "../aggregate.js";
import { readBucketCache, writeBucketCache } from "../cache.js";

// Kraken historical trades via the public REST API.
//   GET https://api.kraken.com/0/public/Trades?pair=DOTUSD&since=<ns>
// Each call returns up to 1000 trades plus `result.last` (a nanosecond
// cursor for the next call). Public-tier rate limit is ~1 req/sec, so we
// throttle accordingly. DOT/USD on Kraken is low-liquidity — typically
// a few thousand trades per day — so a full day is 5–20 paginated calls.
//
// Trade shape:
//   [price_str, volume_str, time_seconds_float, side("b"/"s"), order_type, misc, tradeId]

const PAIR = "DOTUSD";
const RULE = "vwap" as const;
const REST_URL = `https://api.kraken.com/0/public/Trades`;
const PAGINATION_DELAY_MS = 1100;  // Conservative; Kraken's public limit is ~1/s.

export class KrakenSpotSource implements VenueSpotSource {
  readonly id = "kraken" as const;
  readonly pair = PAIR;

  async loadDay(date: string): Promise<VenueBucket[]> {
    const cached = await readBucketCache(this.id, this.pair, date, RULE);
    if (cached) return cached;

    const startSec = dayStartSec(date);
    const endSec = startSec + 86400;
    console.log(`  [kraken ${date}] paginating REST trades from since=${startSec} (UTC)`);
    const trades = await fetchDayTrades(startSec, endSec);
    console.log(`  [kraken ${date}] fetched ${trades.length.toLocaleString()} trades total`);

    const buckets = bucketizeDay(trades, startSec);
    if (buckets.length !== BLOCKS_PER_DAY) {
      throw new Error(`kraken: expected ${BLOCKS_PER_DAY} buckets, got ${buckets.length}`);
    }
    const populated = buckets.reduce((n, b) => n + (b.vwap !== null ? 1 : 0), 0);
    console.log(`  [kraken ${date}] ${trades.length.toLocaleString()} trades → ${populated}/${BLOCKS_PER_DAY} populated buckets`);
    if (populated === 0 && trades.length > 0) {
      throw new Error(
        `Kraken: ${trades.length} trades parsed but 0 buckets populated for ${date}. ` +
        `Likely a clock-skew or filter mismatch; check parser.`
      );
    }
    await writeBucketCache(this.id, this.pair, date, RULE, buckets);
    return buckets;
  }
}

interface KrakenTradesResponse {
  error: string[];
  result?: { last?: string } & Record<string, unknown>;
}

/**
 * Walks the Kraken REST API for one UTC day and returns all trades whose
 * timestamp falls in [startSec, endSec). Paginates until the cursor advances
 * past endSec or the response is empty. Throws on persistent API errors.
 */
async function fetchDayTrades(startSec: number, endSec: number): Promise<RawTrade[]> {
  const out: RawTrade[] = [];
  let cursor = BigInt(startSec) * 1_000_000_000n;
  const endNs = BigInt(endSec) * 1_000_000_000n;
  let calls = 0;

  // Soft cap to avoid an infinite loop on a misbehaving response. 200 calls of
  // 1000 trades each = 200k trades — far above DOT/USD's typical daily volume.
  while (calls < 200) {
    const url = `${REST_URL}?pair=${PAIR}&since=${cursor.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Kraken: ${url} failed with ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as KrakenTradesResponse;
    if (body.error && body.error.length > 0) {
      throw new Error(`Kraken: API error ${body.error.join(", ")}`);
    }
    if (!body.result) {
      throw new Error(`Kraken: response missing 'result'`);
    }
    // The trades array key is the canonical pair name (e.g. "DOTUSD" — but
    // sometimes a normalized form). Skip 'last' and pick the array.
    let tradesArr: unknown[] | undefined;
    for (const [k, v] of Object.entries(body.result)) {
      if (k === "last") continue;
      if (Array.isArray(v)) { tradesArr = v as unknown[]; break; }
    }
    if (!tradesArr) {
      throw new Error(`Kraken: response missing trades array`);
    }
    if (tradesArr.length === 0) break;

    let firstSec = Infinity, lastSec = -Infinity;
    for (const t of tradesArr) {
      // Each trade: [price, volume, time, side, type, misc, tradeId]
      const arr = t as [string, string, number, string, string, string, number];
      const timestampSec = Number(arr[2]);
      const price = Number(arr[0]);
      const qty = Number(arr[1]);
      if (!(price > 0) || !(qty > 0) || !(timestampSec > 0)) continue;
      if (timestampSec < firstSec) firstSec = timestampSec;
      if (timestampSec > lastSec) lastSec = timestampSec;
      // We only retain trades inside the day window; bucketizeDay also
      // filters but doing it here keeps the in-memory accumulator small.
      if (timestampSec >= startSec && timestampSec < endSec) {
        out.push({ timestampSec, price, qty });
      }
    }

    const last = body.result.last;
    if (typeof last !== "string") break;
    const lastNs = BigInt(last);
    if (lastNs <= cursor) break;            // cursor didn't advance
    if (lastNs >= endNs) break;             // we've passed end of day
    cursor = lastNs;
    calls++;
    process.stdout.write(`    [kraken] page ${calls}: trades=${tradesArr.length} window=${new Date(firstSec * 1000).toISOString().slice(11, 19)}–${new Date(lastSec * 1000).toISOString().slice(11, 19)}\n`);
    await sleep(PAGINATION_DELAY_MS);
  }
  if (calls >= 200) {
    throw new Error(`Kraken: hit pagination cap of 200 calls — investigate`);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

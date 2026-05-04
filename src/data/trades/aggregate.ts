import type { PricePoint, VenueId } from "../../types.js";
import { BLOCK_TIME_SECONDS, BLOCKS_PER_DAY, type RawTrade, type VenueBucket } from "./types.js";

/**
 * Bucketize a chronologically-sorted stream of trades for one UTC day into
 * exactly BLOCKS_PER_DAY (14400) per-block VWAPs. Trades whose timestamps fall
 * outside [dayStartSec, dayStartSec + 86400) are silently dropped (caller is
 * responsible for slicing per-day input).
 */
export function bucketizeDay(trades: RawTrade[], dayStartSec: number): VenueBucket[] {
  const buckets: VenueBucket[] = new Array(BLOCKS_PER_DAY);
  const sumPxQty = new Float64Array(BLOCKS_PER_DAY);
  const sumQty = new Float64Array(BLOCKS_PER_DAY);
  const counts = new Int32Array(BLOCKS_PER_DAY);

  const dayEnd = dayStartSec + 86400;
  for (const t of trades) {
    if (t.timestampSec < dayStartSec || t.timestampSec >= dayEnd) continue;
    if (!(t.qty > 0) || !(t.price > 0)) continue;
    const idx = Math.floor((t.timestampSec - dayStartSec) / BLOCK_TIME_SECONDS);
    if (idx < 0 || idx >= BLOCKS_PER_DAY) continue;
    sumPxQty[idx] += t.price * t.qty;
    sumQty[idx] += t.qty;
    counts[idx] += 1;
  }

  for (let i = 0; i < BLOCKS_PER_DAY; i++) {
    const blockTimestamp = dayStartSec + i * BLOCK_TIME_SECONDS;
    if (counts[i] === 0) {
      buckets[i] = { blockTimestamp, vwap: null, tradeCount: 0, volume: 0 };
    } else {
      buckets[i] = {
        blockTimestamp,
        vwap: sumPxQty[i] / sumQty[i],
        tradeCount: counts[i],
        volume: sumQty[i],
      };
    }
  }
  return buckets;
}

/**
 * Combine multiple venues' per-block buckets into a single PricePoint[].
 *
 * For each block index i:
 *   - For each venue, if bucket[i].vwap is null, carry forward that venue's
 *     last-known non-null VWAP (per-venue carry-forward).
 *   - Take the median across the (up to N) venue values that are now non-null.
 *   - If no venue has yet produced a non-null VWAP at block i (start-of-range
 *     edge case), drop the block (it will not appear in the output).
 *
 * The returned PricePoint[] is contiguous in time at the 6s grid for the range
 * starting from the first block where ≥1 venue has data.
 */
export function combineVenuesByMedian(
  perVenue: Map<VenueId, VenueBucket[]>,
): PricePoint[] {
  const venues = [...perVenue.keys()];
  if (venues.length === 0) return [];

  const lengths = new Set(venues.map((v) => perVenue.get(v)!.length));
  if (lengths.size !== 1) {
    throw new Error(
      `combineVenuesByMedian: per-venue bucket arrays must be the same length (got ${[...lengths].join(", ")})`,
    );
  }
  const N = perVenue.get(venues[0])!.length;

  // Per-venue last-seen VWAP, used for carry-forward fill.
  const lastSeen = new Map<VenueId, number | null>();
  for (const v of venues) lastSeen.set(v, null);

  const out: PricePoint[] = [];
  let started = false;

  for (let i = 0; i < N; i++) {
    const values: number[] = [];
    for (const v of venues) {
      const cur = perVenue.get(v)![i];
      if (cur.vwap !== null) {
        lastSeen.set(v, cur.vwap);
        values.push(cur.vwap);
      } else {
        const prev = lastSeen.get(v);
        if (prev !== null && prev !== undefined) values.push(prev);
      }
    }
    if (values.length === 0) {
      // No venue has data yet — skip until the first block any venue prints.
      continue;
    }
    started = true;
    const blockTs = perVenue.get(venues[0])![i].blockTimestamp;
    out.push({ timestamp: blockTs, price: medianSorted(values) });
  }

  if (!started) {
    // No venue produced any non-null VWAP across the entire range.
    throw new Error("combineVenuesByMedian: no venue produced any data in the requested range");
  }
  return out;
}

/** Median of a number array. Sorts in place. */
function medianSorted(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[mid]
    : (values[mid - 1] + values[mid]) / 2;
}

/** Convenience: list each UTC day in [startDate, endDate] inclusive (YYYY-MM-DD). */
export function daysInRange(startDate: string, endDate: string): string[] {
  const start = Date.parse(startDate + "T00:00:00Z");
  const end = Date.parse(endDate + "T00:00:00Z");
  if (isNaN(start) || isNaN(end) || end < start) {
    throw new Error(`daysInRange: invalid range "${startDate}" → "${endDate}"`);
  }
  const out: string[] = [];
  for (let t = start; t <= end; t += 86400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** UTC midnight of a YYYY-MM-DD date in seconds. */
export function dayStartSec(dateYYYYMMDD: string): number {
  const ms = Date.parse(dateYYYYMMDD + "T00:00:00Z");
  if (isNaN(ms)) throw new Error(`dayStartSec: invalid date "${dateYYYYMMDD}"`);
  return Math.floor(ms / 1000);
}

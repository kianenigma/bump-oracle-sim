import type { CrossVenueSpec, PricePoint, VenueId } from "../../types.js";
import { BLOCK_TIME_SECONDS, BLOCKS_PER_DAY, type RawTrade, type VenueBucket } from "./types.js";

/** Per-block prices for the cross-venue median plus, in trades mode, every
 *  individual venue's carry-forward-filled series. Same length as `points`. */
export interface CombinedSource {
  points: PricePoint[];
  venuePrices: Map<VenueId, number[]>;
}

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
 * Combine multiple venues' per-block buckets into a cross-venue median price
 * series, alongside per-venue carry-forward-filled series of equal length.
 *
 * For each block i:
 *   - For each venue, if bucket[i].vwap is non-null: use it (and update that
 *     venue's lastSeen).
 *   - Else fall back to that venue's lastSeen, or — for blocks before the
 *     venue's first print — to the cross-venue median computed at this block.
 *     This guarantees every per-venue array is fully populated and aligned
 *     with `points`, so PriceEndpoint.getPriceByVenue(v, i) is always well-
 *     defined for every venue we returned a series for.
 *   - Cross-venue median is taken over the venues that already have a real
 *     reading (not the median-fallback values), so we don't pollute the
 *     ground-truth median with self-references in the seed phase.
 *   - If no venue has yet produced a non-null VWAP at block i, drop the block.
 *
 * The returned `points` is contiguous in time at the 6s grid starting from
 * the first block where ≥1 venue has data; `venuePrices` arrays have the same
 * length and start.
 */
export function combineVenues(
  perVenue: Map<VenueId, VenueBucket[]>,
  spec: CrossVenueSpec = { kind: "median" },
): CombinedSource {
  const venues = [...perVenue.keys()];
  if (venues.length === 0) {
    return { points: [], venuePrices: new Map() };
  }

  const lengths = new Set(venues.map((v) => perVenue.get(v)!.length));
  if (lengths.size !== 1) {
    throw new Error(
      `combineVenues: per-venue bucket arrays must be the same length (got ${[...lengths].join(", ")})`,
    );
  }
  const N = perVenue.get(venues[0])!.length;

  // Per-venue last-seen VWAP, used for carry-forward fill.
  const lastSeen = new Map<VenueId, number | null>();
  for (const v of venues) lastSeen.set(v, null);

  const points: PricePoint[] = [];
  const venueSeries = new Map<VenueId, number[]>();
  for (const v of venues) venueSeries.set(v, []);
  let started = false;

  for (let i = 0; i < N; i++) {
    // Collect (price, volume, isFresh) for every venue. `price` always uses
    // carry-forward fill so even quiet venues contribute a value when needed.
    // `isFresh` flags whether the venue actually traded this 6s window — used
    // by VWAP to skip stale carry-forwards from the volume weighting.
    const fillFromMedian = (carry: number | null | undefined): number | null =>
      carry !== null && carry !== undefined ? carry : null;

    const samples: Array<{ venue: VenueId; price: number; volume: number; fresh: boolean }> = [];
    let anyFresh = false;
    for (const v of venues) {
      const cur = perVenue.get(v)![i];
      if (cur.vwap !== null) {
        lastSeen.set(v, cur.vwap);
        samples.push({ venue: v, price: cur.vwap, volume: cur.volume, fresh: true });
        anyFresh = true;
      } else {
        const prev = fillFromMedian(lastSeen.get(v));
        if (prev !== null) samples.push({ venue: v, price: prev, volume: 0, fresh: false });
      }
    }

    if (samples.length === 0) continue; // pre-first-print: skip block entirely

    started = true;
    const blockTs = perVenue.get(venues[0])![i].blockTimestamp;

    // Compute the cross-venue real price per the chosen rule.
    let crossPrice: number;
    if (spec.kind === "vwap") {
      // Volume-weight only across venues that actually traded this block.
      // If none did, fall back to the median of carry-forward values.
      const fresh = samples.filter((s) => s.fresh);
      if (fresh.length === 0) {
        crossPrice = medianOf(samples.map((s) => s.price));
      } else {
        let num = 0, den = 0;
        for (const s of fresh) { num += s.price * s.volume; den += s.volume; }
        crossPrice = den > 0 ? num / den : medianOf(fresh.map((s) => s.price));
      }
    } else if (spec.kind === "mean") {
      let sum = 0;
      for (const s of samples) sum += s.price;
      crossPrice = sum / samples.length;
    } else {
      crossPrice = medianOf(samples.map((s) => s.price));
    }

    points.push({ timestamp: blockTs, price: crossPrice });

    // Per-venue series: fresh → bucket vwap; stale → carry forward; pre-first-
    // print → seed from the just-computed cross-venue price.
    for (const v of venues) {
      const cur = perVenue.get(v)![i];
      const arr = venueSeries.get(v)!;
      if (cur.vwap !== null) {
        arr.push(cur.vwap);
      } else {
        const prev = lastSeen.get(v);
        arr.push(prev !== null && prev !== undefined ? prev : crossPrice);
      }
    }
  }

  if (!started) {
    throw new Error("combineVenues: no venue produced any data in the requested range");
  }
  return { points, venuePrices: venueSeries };
}

function medianOf(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return medianSorted(sorted);
}

/** @deprecated Use combineVenues instead; kept for any external callers. */
export function combineVenuesByMedian(perVenue: Map<VenueId, VenueBucket[]>): PricePoint[] {
  return combineVenues(perVenue).points;
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

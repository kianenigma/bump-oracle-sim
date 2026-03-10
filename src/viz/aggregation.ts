import type { OHLCCandle, LinePoint } from "../types.js";

/**
 * Binary search for the first index where timestamps[i] >= target.
 * Returns timestamps.length if all values are < target.
 */
function lowerBound(timestamps: number[], target: number): number {
  let lo = 0;
  let hi = timestamps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timestamps[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Binary search for the first index where timestamps[i] > target.
 * Returns 0 if all values are > target.
 */
function upperBound(timestamps: number[], target: number): number {
  let lo = 0;
  let hi = timestamps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timestamps[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function aggregateOHLC(
  timestamps: number[],
  prices: number[],
  from: number,
  to: number,
  interval: number
): OHLCCandle[] {
  const startIdx = lowerBound(timestamps, from);
  const endIdx = upperBound(timestamps, to);
  if (startIdx >= endIdx) return [];

  const map = new Map<number, OHLCCandle>();
  for (let i = startIdx; i < endIdx; i++) {
    const bucket = Math.floor(timestamps[i] / interval) * interval;
    const p = prices[i];
    const c = map.get(bucket);
    if (!c) {
      map.set(bucket, { time: bucket, open: p, high: p, low: p, close: p });
    } else {
      if (p > c.high) c.high = p;
      if (p < c.low) c.low = p;
      c.close = p;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

export function aggregateLine(
  timestamps: number[],
  prices: number[],
  from: number,
  to: number,
  interval: number
): LinePoint[] {
  const startIdx = lowerBound(timestamps, from);
  const endIdx = upperBound(timestamps, to);
  if (startIdx >= endIdx) return [];

  if (interval <= 6) {
    const result: LinePoint[] = [];
    for (let i = startIdx; i < endIdx; i++) {
      result.push({ time: timestamps[i], value: prices[i] });
    }
    return result;
  }

  const map = new Map<number, number>();
  for (let i = startIdx; i < endIdx; i++) {
    const bucket = Math.floor(timestamps[i] / interval) * interval;
    map.set(bucket, prices[i]); // last value in bucket = close
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));
}

export function aggregateDeviation(
  timestamps: number[],
  deviations: number[],
  from: number,
  to: number,
  interval: number
): LinePoint[] {
  const startIdx = lowerBound(timestamps, from);
  const endIdx = upperBound(timestamps, to);
  if (startIdx >= endIdx) return [];

  if (interval <= 6) {
    const result: LinePoint[] = [];
    for (let i = startIdx; i < endIdx; i++) {
      result.push({ time: timestamps[i], value: deviations[i] });
    }
    return result;
  }

  const map = new Map<number, number>();
  for (let i = startIdx; i < endIdx; i++) {
    const bucket = Math.floor(timestamps[i] / interval) * interval;
    const existing = map.get(bucket);
    if (existing === undefined || deviations[i] > existing) {
      map.set(bucket, deviations[i]);
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));
}

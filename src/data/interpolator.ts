import type { Candle, PricePoint } from "../types.js";
import { BLOCK_TIME_SECONDS } from "../config.js";

/**
 * Linearly interpolate 1-minute candles to 6-second price points.
 * Uses the close price of each candle as the anchor.
 */
export function interpolateToBlocks(candles: Candle[]): PricePoint[] {
  if (candles.length < 2) {
    return candles.map((c) => ({ timestamp: c.timestamp, price: c.close }));
  }

  const points: PricePoint[] = [];
  const step = BLOCK_TIME_SECONDS;

  for (let i = 0; i < candles.length - 1; i++) {
    const c0 = candles[i];
    const c1 = candles[i + 1];
    const tStart = c0.timestamp;
    const tEnd = c1.timestamp;
    const duration = tEnd - tStart;

    if (duration <= 0) continue;

    // Generate points from c0.timestamp up to (but not including) c1.timestamp
    for (let t = tStart; t < tEnd; t += step) {
      const frac = (t - tStart) / duration;
      const price = c0.close + frac * (c1.close - c0.close);
      points.push({ timestamp: t, price });
    }
  }

  // Add the last candle's close price
  const last = candles[candles.length - 1];
  points.push({ timestamp: last.timestamp, price: last.close });

  return points;
}

/**
 * Calculate the maximum absolute 6-second price delta in the dataset.
 * Used for epsilon auto-calculation.
 */
export function maxBlockDelta(points: PricePoint[]): number {
  let max = 0;
  for (let i = 1; i < points.length; i++) {
    const delta = Math.abs(points[i].price - points[i - 1].price);
    if (delta > max) max = delta;
  }
  return max;
}

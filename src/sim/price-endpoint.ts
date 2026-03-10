import type { PricePoint } from "../types.js";
import { gaussianRandom } from "../rng.js";

/**
 * Simulates an external price endpoint that each validator queries.
 * Returns the real price with optional Gaussian jitter to simulate
 * slightly different exchange feeds per validator.
 */
export class PriceEndpoint {
  private points: PricePoint[];
  private index: number = 0;

  constructor(points: PricePoint[]) {
    this.points = points;
  }

  /** Get the real price at a given block index */
  getRealPrice(blockIndex: number): number {
    const idx = Math.min(blockIndex, this.points.length - 1);
    return this.points[idx].price;
  }

  /** Get the timestamp at a given block index */
  getTimestamp(blockIndex: number): number {
    const idx = Math.min(blockIndex, this.points.length - 1);
    return this.points[idx].timestamp;
  }

  /** Get price with per-validator jitter */
  getJitteredPrice(blockIndex: number, rng: () => number, jitterStdDev: number): number {
    const real = this.getRealPrice(blockIndex);
    if (jitterStdDev === 0) return real;
    return gaussianRandom(rng, real, real * jitterStdDev);
  }

  get totalBlocks(): number {
    return this.points.length;
  }
}

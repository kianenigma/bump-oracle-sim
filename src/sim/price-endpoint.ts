import type { PricePoint, ValidatorPriceSource, VenueId } from "../types.js";
import { gaussianRandom } from "../rng.js";

/**
 * Simulates an external price endpoint that each validator queries.
 *
 * Two modes of operation:
 *   - Cross-venue median (or candle-interpolated) price as ground truth.
 *     Available always via getRealPrice / getJitteredPrice.
 *   - Per-venue series, available only when the simulation was started with
 *     `--data-source=trades`. Surfaced via getPriceByVenue and
 *     getPriceByRandomVenue. These throw if no per-venue data was loaded.
 */
export class PriceEndpoint {
  private points: PricePoint[];
  private venueIds: VenueId[];
  /** Per-venue carry-forward-filled price arrays, same length as `points`. */
  private venuePrices: Record<VenueId, number[]> | undefined;

  constructor(points: PricePoint[], venuePrices?: Record<VenueId, number[]>) {
    this.points = points;
    this.venuePrices = venuePrices;
    this.venueIds = venuePrices ? (Object.keys(venuePrices) as VenueId[]) : [];
  }

  /** Get the cross-venue median (or candle) real price at a given block index. */
  getRealPrice(blockIndex: number): number {
    const idx = Math.min(blockIndex, this.points.length - 1);
    return this.points[idx].price;
  }

  /** Get the timestamp at a given block index. */
  getTimestamp(blockIndex: number): number {
    const idx = Math.min(blockIndex, this.points.length - 1);
    return this.points[idx].timestamp;
  }

  /** Real price + Gaussian jitter scaled by jitterStdDev (a fraction of price). */
  getJitteredPrice(blockIndex: number, rng: () => number, jitterStdDev: number): number {
    const real = this.getRealPrice(blockIndex);
    if (jitterStdDev === 0) return real;
    return gaussianRandom(rng, real, real * jitterStdDev);
  }

  /** True iff per-venue prices are available (i.e. simulation is in trades mode). */
  hasVenues(): boolean {
    return this.venueIds.length > 0;
  }

  /** All venue ids that have a loaded price series, in the order they were loaded. */
  availableVenues(): VenueId[] {
    return this.venueIds.slice();
  }

  /** Get a specific venue's price at the given block. Throws if the simulation is
   *  not in trades mode, or if the venue is not among the loaded set. */
  getPriceByVenue(venue: VenueId, blockIndex: number): number {
    if (!this.venuePrices) {
      throw new Error(
        `getPriceByVenue: per-venue prices are not loaded (this simulation is using ` +
        `--data-source=candles). Use --data-source=trades and select venues to enable.`,
      );
    }
    const series = this.venuePrices[venue];
    if (!series) {
      throw new Error(
        `getPriceByVenue: venue "${venue}" was not loaded. Available: ${this.venueIds.join(", ") || "(none)"}`,
      );
    }
    const idx = Math.min(blockIndex, series.length - 1);
    return series[idx];
  }

  /** Pick a random venue (uniform over the loaded set) and return its price at
   *  the given block. Throws if not in trades mode. The provided RNG is used so
   *  the choice is reproducible per validator. */
  getPriceByRandomVenue(rng: () => number, blockIndex: number): number {
    if (!this.venuePrices || this.venueIds.length === 0) {
      throw new Error(
        `getPriceByRandomVenue: per-venue prices are not loaded (this simulation is using ` +
        `--data-source=candles). Use --data-source=trades and select venues to enable.`,
      );
    }
    const v = this.venueIds[Math.floor(rng() * this.venueIds.length)];
    return this.getPriceByVenue(v, blockIndex);
  }

  /** Composes "which underlying source" + jitter for a validator's observation.
   *  Centralizes the price-source dispatch so every validator type uses identical
   *  logic and jitter is always applied uniformly on top.
   *
   *  - source.kind === "median": jittered cross-venue median (current default).
   *  - source.kind === "random-venue": jittered price from a random venue. */
  observe(
    source: ValidatorPriceSource,
    blockIndex: number,
    rng: () => number,
    jitterStdDev: number,
  ): number {
    let basePrice: number;
    if (source.kind === "random-venue") {
      basePrice = this.getPriceByRandomVenue(rng, blockIndex);
    } else {
      basePrice = this.getRealPrice(blockIndex);
    }
    if (jitterStdDev === 0) return basePrice;
    return gaussianRandom(rng, basePrice, basePrice * jitterStdDev);
  }

  get totalBlocks(): number {
    return this.points.length;
  }
}

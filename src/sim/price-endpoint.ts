import type { PricePoint, ValidatorPriceSource, VenueId } from "../types.js";
import { gaussianRandom } from "../rng.js";

/**
 * Simulates the price feed seen by validators.
 *
 * Two layers:
 *   - Cross-venue real price (`pricePoints`) — the ground truth for the
 *     simulation. Computed once by `combineVenues` per the active
 *     `CrossVenueSpec` (default: mean across venues).
 *   - Per-venue series — only present when the simulation was loaded with
 *     `--data-source=trades`. Each `VenueId` maps to a carry-forward-filled
 *     price array of the same length as `pricePoints`.
 *
 * Validators reach into this via `observe(priceSource, ...)`, which
 *   - picks the underlying value (cross-venue real OR a random venue), then
 *   - applies Gaussian jitter from `priceSource.jitterStdDev`.
 */
export class PriceEndpoint {
  private points: PricePoint[];
  private venueIds: VenueId[];
  private venuePrices: Record<VenueId, number[]> | undefined;

  constructor(points: PricePoint[], venuePrices?: Record<VenueId, number[]>) {
    this.points = points;
    this.venuePrices = venuePrices;
    this.venueIds = venuePrices ? (Object.keys(venuePrices) as VenueId[]) : [];
  }

  /** Cross-venue real price at block `i` (clamped to series end). */
  getRealPrice(blockIndex: number): number {
    const idx = Math.min(blockIndex, this.points.length - 1);
    return this.points[idx].price;
  }

  getTimestamp(blockIndex: number): number {
    const idx = Math.min(blockIndex, this.points.length - 1);
    return this.points[idx].timestamp;
  }

  /** True iff per-venue prices are loaded (i.e. `--data-source=trades`). */
  hasVenues(): boolean {
    return this.venueIds.length > 0;
  }

  /** All venue ids in the loaded set, in load order. */
  availableVenues(): VenueId[] {
    return this.venueIds.slice();
  }

  /** Specific venue's price at block `i`. Throws if venues aren't loaded. */
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

  /** Pick a uniformly random venue and return its price at block `i`. */
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

  /**
   * Validator observation: dispatch on `priceSource.kind`, then apply
   * Gaussian jitter scaled by `priceSource.jitterStdDev`. Centralizes the
   * lookup so every validator type uses identical logic.
   */
  observe(
    source: ValidatorPriceSource,
    blockIndex: number,
    rng: () => number,
  ): number {
    const basePrice = source.kind === "random-venue"
      ? this.getPriceByRandomVenue(rng, blockIndex)
      : this.getRealPrice(blockIndex);
    if (source.jitterStdDev === 0) return basePrice;
    return gaussianRandom(rng, basePrice, basePrice * source.jitterStdDev);
  }

  get totalBlocks(): number {
    return this.points.length;
  }
}

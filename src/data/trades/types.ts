import type { VenueId } from "../../types.js";

/** A single trade as parsed from a venue's CSV dump (post-normalization). */
export interface RawTrade {
  /** Unix seconds (with fractional ms; venues vary, all converted at parse time). */
  timestampSec: number;
  price: number;
  /** Base-asset quantity (e.g. DOT). */
  qty: number;
}

/** One 6-second block's worth of price information from a single venue. */
export interface VenueBucket {
  /** Block start, Unix seconds, aligned to the 6s grid. */
  blockTimestamp: number;
  /** Volume-weighted average price across trades in this window, or null if no trades. */
  vwap: number | null;
  /** Number of trades aggregated into this bucket. */
  tradeCount: number;
  /** Sum of base-asset volume across trades in this window. */
  volume: number;
}

/** Reduction rule used inside a single venue's 6s window. Recorded in the cache
 *  meta so a stale on-disk bucket can be detected if the rule changes. */
export type WithinVenueRule = "vwap" | "median" | "last" | "mean";

export interface VenueSpotSource {
  readonly id: VenueId;
  /** Trading pair as the venue spells it (e.g. "DOTUSDT", "DOTUSD", "DOT_USDT"). */
  readonly pair: string;
  /**
   * Returns 6s VWAP buckets for the UTC day [date, date+1d).
   * Length is exactly 14400 (= 86400 / 6); buckets with no trades have vwap=null.
   * Implementations are expected to use the per-venue cache transparently.
   */
  loadDay(dateYYYYMMDD: string): Promise<VenueBucket[]>;
}

export const BLOCK_TIME_SECONDS = 6;
export const BLOCKS_PER_DAY = 86400 / BLOCK_TIME_SECONDS; // 14400

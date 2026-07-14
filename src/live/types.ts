import type { VenueId } from "../types.js";

// ── Live ticker data ─────────────────────────────────────────────────────────

/** Quote assets we understand. USD is the normalization target. */
export type QuoteAsset = "USD" | "USDT" | "USDC";
export type BaseAsset = "DOT" | "USDT" | "USDC";

/** One live ticker observation for a single (venue, pair). */
export interface TickerPoint {
  venue: VenueId;
  /** Normalized pair id, e.g. "DOT/USDT", "USDT/USD". */
  pair: string;
  base: BaseAsset;
  quote: QuoteAsset;
  /** Last traded price as reported by the venue. */
  last: number;
  /** 24h volume in QUOTE units (derived from base volume × last when the
   *  venue reports base volume only). Used for VWAP weighting + the 1%
   *  volume floor. */
  quoteVolume24h: number;
  /** Venue-reported timestamp (ms), when available. */
  venueTsMs: number | null;
}

/** A TickerPoint enriched by the feed with freshness bookkeeping. */
export interface FreshTickerPoint extends TickerPoint {
  /** Wall-clock ms when this point was last fetched successfully. */
  fetchedAtMs: number;
  /** Wall-clock ms when the price last CHANGED (stagnation detector for the
   *  Mini Oracle's 8h staleness filter). */
  lastChangedMs: number;
}

/** Per-venue fetch health, surfaced in the UI. */
export interface VenueStatus {
  ok: boolean;
  /** ms since the last successful fetch (0 when this tick succeeded). */
  ageMs: number;
  /** Error message of the most recent failure, if any. */
  lastError: string | null;
}

/** The shared per-block snapshot every validator reads from. */
export interface FeedSnapshot {
  atMs: number;
  points: FreshTickerPoint[];
  venueStatus: Record<string, VenueStatus>;
}

// ── Mini Oracle pipeline ─────────────────────────────────────────────────────

export interface MiniOracleOptions {
  /** MAD outlier multiplier k: drop |p − median| > k·MAD. */
  madK: number;
  /** Volume floor as a fraction of total (design doc: 0.01). */
  volumeFloorFrac: number;
  /** Staleness cutoff in ms (design doc: 8h). */
  stalenessMaxMs: number;
  nowMs: number;
}

export type DropReason = "stale" | "volume" | "mad";

/** One DOT price point as it moves through the pipeline. */
export interface TracePoint {
  venue: VenueId;
  pair: string;
  rawLast: number;
  /** Price after USD normalization. */
  usdPrice: number;
  /** 24h volume in USD terms (VWAP weight). */
  usdVolume24h: number;
  /** Why this point was excluded, or null if it survived to the final VWAP. */
  dropped: DropReason | null;
}

/** Full audit trail of one Mini Oracle evaluation. */
export interface MiniOracleTrace {
  usdtUsd: number;
  usdcUsd: number;
  /** True when no genuine stable/USD market was visible and 1.0 was assumed. */
  usdIndexAssumed: boolean;
  points: TracePoint[];
  median: number | null;
  mad: number | null;
  /** Final VWAP over surviving points; null if nothing survived. */
  quote: number | null;
}

// ── Per-block live records ───────────────────────────────────────────────────

/** What one validator did this block (quote already includes its jitter). */
export interface LiveSubmissionRecord {
  validatorIndex: number;
  /** null = abstained (pipeline had no data). */
  price: number | null;
  /** Venues visible to this validator this block. */
  venues: VenueId[];
  /** Pipeline point counts: used = survived to VWAP, dropped per reason. */
  used: number;
  droppedStale: number;
  droppedVolume: number;
  droppedMad: number;
}

/** Slim per-block record kept for every block (JSONL-persisted). */
export interface LiveBlockRecord {
  block: number;
  /** Unix seconds, 6s-aligned. */
  timestamp: number;
  realPrice: number;
  oraclePrice: number;
  prevOraclePrice: number;
  authorIndex: number;
  priceUpdated: boolean;
  medianValidatorIndex: number | null;
  inherentTotal: number;
  submissions: LiveSubmissionRecord[];
  /** Per-venue representative USD price this block (for venue chart lines). */
  venuePrices: Record<string, number | null>;
  venueStatus: Record<string, VenueStatus>;
}

/** Heavy per-validator traces, kept only for the most recent blocks. */
export interface LiveBlockTraces {
  block: number;
  traces: Map<number, MiniOracleTrace>;
}

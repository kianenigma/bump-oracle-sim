export enum Bump {
  Up = 1,
  Down = -1,
}

export interface Candle {
  timestamp: number; // Unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PricePoint {
  timestamp: number; // Unix seconds
  price: number;
}

export interface BumpSubmission {
  validatorIndex: number;
  bump: Bump;
}

// ── Aggregator selection ──
//
// AggregatorMode is the bare tag (used in summaries, labels, registries).
// AggregatorConfig is the *configured* form including any per-aggregator
// parameters. They are kept separate so SimulationSummary stays a flat enum
// while config can carry parameters cleanly.
//
// Behaviors:
//   "nudge"        : current design — validators emit Up/Down, author picks subset,
//                    runtime applies (net × ε). Only mode that uses ε.
//   "median"       : validators submit absolute price quotes, runtime takes the
//                    median. Robust to outliers up to <50% adversarial.
//   "trimmed-mean" : validators submit absolute price quotes, runtime drops the
//                    top k% and bottom k% by value, then averages the rest.
//                    Smooths jitter better than median; weaker outlier rejection.
export type AggregatorMode = "nudge" | "median" | "trimmed-mean";

export type AggregatorConfig =
  | { kind: "nudge" }
  | { kind: "median" }
  | { kind: "trimmed-mean"; k: number };  // k = fraction trimmed from each tail (e.g. 0.1 = drop top 10% + bottom 10%)

export function aggregatorMode(cfg: AggregatorConfig): AggregatorMode {
  return cfg.kind;
}

// ── Price-data source selection ──────────────────────────────────────────────
// The simulator can be fed by two pipelines, both producing PricePoint[]:
//   "candles" : Binance US 1-minute OHLC linearly interpolated to 6s blocks
//               (existing path; fast iteration, smooths intra-minute dynamics).
//   "trades"  : per-trade data from one or more spot venues, bucketed to 6s
//               VWAP per venue, then median across venues per block.
//               (new path; preserves intra-minute volatility, reflects
//               cross-venue price discovery).
export type VenueId = "binance" | "kraken" | "bybit" | "gate";

// How per-venue 6s VWAPs are combined into a single cross-venue real price
// per block. The result is the "ground truth" the oracle is compared against
// and the source of the median validators see in `validatorPriceSource: median`.
//   "median"  : middle value across venues (current default; matches the old behavior).
//             For 4 venues this averages the middle 2 — naturally damps a single outlier.
//   "vwap"    : volume-weighted across venues. Quiet venues contribute less; the
//             active market dominates. Falls back to median of carry-forward
//             values for blocks where no venue has fresh trades.
//   "mean"    : simple arithmetic mean across venues. Equal weight regardless
//             of activity — illiquid venues pull as much as active ones.
export type CrossVenueSpec =
  | { kind: "median" }
  | { kind: "vwap" }
  | { kind: "mean" };

export type DataSourceSpec =
  | { kind: "candles" }
  | { kind: "trades"; venues: VenueId[]; crossVenue?: CrossVenueSpec };

// Where each validator gets its own observation of the price.
//   "median"        : every validator sees the cross-venue median (or candle-
//                     interpolated value), with per-validator Gaussian jitter
//                     applied on top. The current/default behavior.
//   "random-venue"  : every validator query picks a random venue from the
//                     loaded set and observes that venue's price (with jitter
//                     applied on top). Only valid when dataSource.kind=="trades".
export type ValidatorPriceSource =
  | { kind: "median" }
  | { kind: "random-venue" };

/** What `loadPriceSource` returns: the resolved 6s price grid plus, when in
 *  trades mode, per-venue carry-forward-filled price arrays of the same length. */
export interface ResolvedPriceSource {
  pricePoints: PricePoint[];
  venuePrices?: Record<VenueId, number[]>;
}

// ── Malicious validator parameters ───────────────────────────────────────────
// All knobs that govern adversarial behavior. Surfaced on SimulationConfig so
// scenarios can vary them and so they show up in stdout / UI alongside the
// rest of the run config.
export interface MaliciousParams {
  /** How many blocks behind DelayedValidator reads its price (default 10 = 60s at 6s blocks). */
  delayBlocks: number;
  /** PushyMaliciousValidator quote-mode outlier magnitude, as a fraction of real price (default 0.05 = 5%). */
  pushyQuoteBias: number;
  /** DriftValidator quote-mode per-block multiplicative bias (default 0.001 = 0.1% per block). */
  driftQuoteStep: number;
}

// What a single validator submits per block. Aggregators consume an array of these.
// - "nudge"  : signed direction only (current behavior)
// - "quote"  : absolute price (used by median / trimmed-mean)
// - "abstain": validator opted not to submit (used by NoopValidator under non-nudge aggregators)
export type Submission =
  | { kind: "nudge"; validatorIndex: number; bump: Bump }
  | { kind: "quote"; validatorIndex: number; price: number }
  | { kind: "abstain"; validatorIndex: number };

export interface BlockMetrics {
  block: number;
  timestamp: number;
  realPrice: number;
  oraclePrice: number;
  authorIndex: number;
  authorIsHonest: boolean;
  totalBumps: number;
  activatedBumps: number;
  netDirection: number; // positive = up, negative = down
  deviation: number; // absolute difference real - oracle
  deviationPct: number; // percentage deviation
}

// Per-type entry: plain number = fraction with default jitter, or object for custom jitter.
// Example: 0.33 or { fraction: 0.33, jitter: 0.005 }
export type ValidatorMixEntry = number | { fraction?: number; jitter?: number };

// Maps validator type name to its config.
// "honest" is implicit: its fraction = 1 - sum(all other fractions).
// A "honest" key is allowed to override jitter only (fraction is ignored).
// Example: { malicious: 0.2, pushy: { fraction: 0.1, jitter: 0.005 } }
export type ValidatorMix = Record<string, ValidatorMixEntry>;

// Epsilon specification: how much the oracle price moves per activated bump.
// - number: absolute step size (e.g. 0.00033)
// - "auto": auto-compute from price data
// - { ratio: number }: per-bump fraction of current oracle price (e.g. 0.0001 = 0.01% per bump)
export type EpsilonSpec = number | "auto" | { ratio: number };

export type EpsilonMode = "abs" | "ratio";

export function epsilonValue(spec: EpsilonSpec): number {
  if (spec === "auto") return 0;
  if (typeof spec === "number") return spec;
  return spec.ratio;
}

export function epsilonMode(spec: EpsilonSpec): EpsilonMode {
  if (typeof spec === "object" && "ratio" in spec) return "ratio";
  return "abs";
}

export interface SimulationConfig {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  validatorCount: number;
  validatorMix: ValidatorMix; // fractions for non-honest validator types
  epsilon: EpsilonSpec;
  seed: number;
  jitterStdDev: number; // price jitter std dev as fraction (e.g. 0.001 = 0.1%)
  convergenceThreshold: number; // deviation % threshold for convergence (default 0.1)
  label: string;
  /** Aggregation rule + per-aggregator parameters. Defaults to { kind: "nudge" }. */
  aggregator?: AggregatorConfig;
  /** Per-validator-type adversarial knobs. Defaults to DEFAULT_MALICIOUS_PARAMS in config.ts. */
  maliciousParams?: MaliciousParams;
  /** Where the price feed comes from. Defaults to { kind: "candles" } (back-compat). */
  dataSource?: DataSourceSpec;
  /** Where each validator gets its observation. Defaults to { kind: "median" }. */
  validatorPriceSource?: ValidatorPriceSource;
}

export interface SimulationResult {
  config: SimulationConfig;
  summary: SimulationSummary;
}

export interface SimulationSummary {
  /// Total number of blocks in the simulation
  totalBlocks: number;
  /// Aggregation rule that produced this run (recorded so labels/charts are unambiguous).
  aggregator: AggregatorMode;
  /// The resolved epsilon value used in the simulation (absolute step, or per-bump ratio).
  /// Only meaningful when aggregator === "nudge"; ignored for "median" / "trimmed-mean".
  epsilon: number;
  /// Whether epsilon is an absolute step ("abs") or a fraction of oracle price ("ratio")
  epsilonMode: EpsilonMode;
  /// The threshold used for convergence (in %), and the convergance itself.
  ///
  /// If set to 1%, blocks in which deviation was less than 1% are counted as converged.
  convergenceThreshold: number;
  convergenceRate: number;
  /// The arithmetic mean (aka. average) deviation in the simulation.
  meanDeviation: number;
  meanDeviationPct: number;
  /// The max deviation in the simulation.
  maxDeviation: number;
  maxDeviationPct: number;
  /// The integral of the deviation over time.
  deviationIntegral: number;
  /// The maximum rate of deviation change.
  maxDeviationRate: number;
  /// Longest consecutive streak of blocks where deviationPct >= convergenceThreshold.
  maxConsecutiveBlocksAboveThreshold: number;
  /// 95th percentile of deviationPct across all blocks.
  p95DeviationPct: number;
  /// 99th percentile of deviationPct across all blocks.
  p99DeviationPct: number;
}

export interface CacheMetadata {
  asset: string;
  quote: string;
  interval: string;
  source: string;
  startDate: string;
  endDate: string;
  dataPoints: number;
  data: Candle[];
}

// ── .simdata directory format (chunked) ──

export const BLOCKS_PER_CHUNK = 1_000_000;

export interface BlockChunk {
  chunkIndex: number;
  blockOffset: number;
  blockCount: number;
  timestamps: number[];
  realPrices: number[];
  oraclePrices: number[];
  deviationPcts: number[];
}

export interface ScenarioMeta {
  config: SimulationConfig;
  summary: SimulationSummary;
  blockCount: number;
  chunkCount: number;
  timeRange: { from: number; to: number };
  /** Per-chunk time ranges for fast chunk skipping (absent in legacy .simdata dirs). */
  chunkTimeRanges?: Array<{ from: number; to: number }>;
  /** Directory name within the .simdata dir (absent in legacy dirs → falls back to scenario_<idx>). */
  dir?: string;
}

export interface SimDataIndex {
  scenarioCount: number;
  scenarios: ScenarioMeta[];
}

// ── API response types ──

export interface OHLCCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface LinePoint {
  time: number;
  value: number;
}

export interface ApiScenarioMeta {
  index: number;
  config: SimulationConfig;
  summary: SimulationSummary;
  timeRange: { from: number; to: number };
  blockCount: number;
}

export interface ApiMetaResponse {
  scenarioCount: number;
  scenarios: ApiScenarioMeta[];
}

export interface ApiOracleData {
  index: number;
  label: string;
  ohlc: OHLCCandle[];
  line: LinePoint[];
  deviation: LinePoint[];
}

export interface ApiDataResponse {
  tf: number;
  requestedTF: number;
  from: number;
  to: number;
  realPrice: {
    ohlc: OHLCCandle[];
    line: LinePoint[];
  };
  oracles: ApiOracleData[];
  /** Per-venue price lines, present only when the .simdata was produced from
   *  trade data. Keyed by VenueId. Each is downsampled for the visible window. */
  venues?: Record<string, LinePoint[]>;
}

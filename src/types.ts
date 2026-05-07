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

// ── Aggregator selection ────────────────────────────────────────────────────
// AggregatorMode is the bare tag (used in summaries, labels, registries).
// AggregatorConfig is the *configured* form including any per-aggregator
// parameters. They are kept separate so SimulationSummary stays a flat enum
// while config can carry parameters cleanly.
//
// Behaviors:
//   "nudge"  : validators emit Up/Down, author picks subset, runtime applies
//              (net × ε). Only mode that uses ε. Epsilon lives on the
//              aggregator config (was top-level before).
//   "median" : validators submit absolute price quotes; runtime sorts, drops
//              the top `k` and bottom `k` by value, then takes the median of
//              what remains. k defaults to 0 (plain median). Trimming before
//              the median rarely changes the price (median is already
//              outlier-robust) but reflects in the activated-vs-total counts.
//   "mean"   : same trim step, then arithmetic mean of the survivors. k
//              defaults to 0 (plain mean across all quotes). Smoother than
//              median; weaker outlier rejection at small k.
export type AggregatorMode = "nudge" | "median" | "mean";

// Epsilon specification: how much the oracle price moves per activated bump.
// - number: absolute step size (e.g. 0.00033)
// - "auto": auto-compute from price data (max 6s delta / validator count)
// - { ratio: number }: per-bump fraction of current oracle price
export type EpsilonSpec = number | "auto" | { ratio: number };
export type EpsilonMode = "abs" | "ratio";

// `minInputs`: minimum number of relevant submissions in the inherent for the
// aggregator to update the price. If fewer arrive, the price is held.
//   nudge  default = 0      (a 0-bump inherent already holds price naturally)
//   median default = floor(2/3 × N) + 1   (≥ 50%+1 must be honest under
//   mean   default = floor(2/3 × N) + 1    Polkadot's 2/3-honest assumption,
//                                          so the median/mean is protected)
// Defaults are resolved by the engine once it knows N.
// `confidence`: opt-in confidence-tracking + exclusion policy. See
// src/sim/aggregator.ts for the callback. "off" (default) is the legacy
// behaviour: no per-validator state, no exclusion. "default" wires in
// `defaultConfidenceUpdate`, which slowly rewards quotes near the final
// price and penalises absence + far-from-median quotes; once a validator
// hits 0 confidence they are excluded from future aggregation.
//
// `permanentExclusion`: when a validator's confidence first reaches 0,
// is the exclusion sticky (cannot recover) or transient (recovers when
// the callback raises confidence again). Default true.
export type ConfidencePolicy = "off" | "default" | "wideband" | "wideband-strict" | "wideband-attributed";

export type AggregatorConfig =
  | { kind: "nudge"; epsilon: EpsilonSpec; minInputs?: number }
  | { kind: "median"; k?: number; minInputs?: number; confidence?: ConfidencePolicy; permanentExclusion?: boolean }
  | { kind: "mean";   k?: number; minInputs?: number; confidence?: ConfidencePolicy; permanentExclusion?: boolean; weighted?: boolean };

export function aggregatorMode(cfg: AggregatorConfig): AggregatorMode {
  return cfg.kind;
}

export function epsilonValue(spec: EpsilonSpec): number {
  if (spec === "auto") return 0;
  if (typeof spec === "number") return spec;
  return spec.ratio;
}

export function epsilonMode(spec: EpsilonSpec): EpsilonMode {
  if (typeof spec === "object" && "ratio" in spec) return "ratio";
  return "abs";
}

// ── Price-data source selection ─────────────────────────────────────────────
// The simulator can be fed by two pipelines, both producing PricePoint[]:
//   "candles" : Binance US 1-minute OHLC linearly interpolated to 6s blocks
//               (existing path; fast iteration, smooths intra-minute dynamics).
//   "trades"  : per-trade data from one or more spot venues, bucketed to 6s
//               VWAP per venue, then combined via `crossVenue`.
export type VenueId = "binance" | "kraken" | "bybit" | "gate" | "okx" | "coinbase";

// How per-venue 6s VWAPs are combined into a single cross-venue real price
// per block. The result is the "ground truth" the oracle is compared against
// and the source the validators see when their priceSource is "cross-venue".
//   "mean"    : simple arithmetic mean across venues. Equal weight regardless
//               of activity. **Default.** Matches the philosophical "fair"
//               price the simulation is trying to discover.
//   "median"  : middle value across venues. Naturally damps a single outlier.
//   "vwap"    : volume-weighted across venues. Quiet venues contribute less.
export type CrossVenueSpec =
  | { kind: "mean" }
  | { kind: "median" }
  | { kind: "vwap" };

// How the real (ground-truth) price for the simulation is produced.
// Two pipelines, both yielding a 6s-aligned PricePoint[]:
//   "candles" — Binance US 1m OHLC interpolated to 6s.
//   "trades"  — per-trade dumps from one or more venues, bucketed to 6s VWAP
//               per venue, then combined via `crossVenue` (default: mean).
export type RealPriceSpec =
  | { kind: "candles" }
  | { kind: "trades"; venues: VenueId[]; crossVenue?: CrossVenueSpec }
  | { kind: "synthetic"; venues: VenueId[]; venueJitterStdDev: number };

// Per-validator price observation strategy. Each group carries its own copy,
// so different groups can observe the price differently in the same sim.
//   "cross-venue"  : validator sees the cross-venue real price (what the
//                    chart calls Real Price), with Gaussian jitter on top.
//   "random-venue" : validator picks a random venue per query and sees that
//                    venue's price, with Gaussian jitter on top. Only valid
//                    when realPrice.kind == "trades".
//
// `jitterStdDev` is folded in here (was a top-level config knob). 0 = no jitter.
export type ValidatorPriceSource =
  | { kind: "cross-venue"; jitterStdDev: number }
  | { kind: "random-venue"; jitterStdDev: number };

/** What `loadPriceSource` returns: the resolved 6s price grid plus, when in
 *  trades mode, per-venue carry-forward-filled price arrays of the same length. */
export interface ResolvedPriceSource {
  pricePoints: PricePoint[];
  venuePrices?: Record<VenueId, number[]>;
}

// ── Validator groups ────────────────────────────────────────────────────────
// Each group is a (type, count, priceSource, params) tuple. Replaces the
// old top-level (validatorCount, validatorMix, jitterStdDev,
// validatorPriceSource, maliciousParams) bundle. A simulation's full
// validator set is the concatenation of all groups, in order.
export type ValidatorType = "honest" | "malicious" | "pushy" | "noop" | "delayed" | "drift" | "withholder" | "bias-injector" | "overshoot-ratchet" | "stealth-withholder" | "convergent-cabal" | "inband-shifter";

/** Type-specific behavior knobs. Required keys depend on `type`:
 *    delayed   → delayBlocks
 *    pushy     → pushyQuoteBias
 *    malicious → maliciousQuoteBias  (quote-mode strength of the attack)
 *    drift     → driftQuoteStep
 *  Other types ignore this object. Defaults applied in engine if omitted. */
export interface ValidatorParams {
  /** delayed: how many 6s blocks behind the validator reads. */
  delayBlocks?: number;
  /** pushy: quote-mode outlier magnitude as a fraction of real price. */
  pushyQuoteBias?: number;
  /** malicious: quote-mode outlier magnitude (fraction of lastPrice) pushed
   *  in the OPPOSITE direction of real motion. Higher = stronger attack.
   *  0 → "no-change" vote at lastPrice; 1 → would push by 100% of price. */
  maliciousQuoteBias?: number;
  /** drift: quote-mode per-block multiplicative bias. */
  driftQuoteStep?: number;
  /** withholder: which direction of oracle motion the cabal suppresses.
   *  "up"   = abstain when honest observation > lastPrice (oracle never rises)
   *  "down" = abstain when honest observation < lastPrice (oracle never falls)
   *  Coordination is implicit: every withholder evaluates the same condition
   *  against (its observation, lastPrice) — no shared state needed. */
  withholderDirection?: "up" | "down";
  /** bias-injector: which direction of price motion the cabal biases TOWARD.
   *  "up"   = oracle is ratcheted upward (against real-down moves)
   *  "down" = oracle is ratcheted downward (against real-up moves)
   *  Quote mode: identical to withholder (abstain on against-direction obs).
   *  Nudge mode: all members emit `direction` bumps unconditionally; cabal
   *  authors select all in-direction bumps (overshoot); on against-direction
   *  real motion blocks, cabal authors return [] (freeze the correction). */
  biasInjectorDirection?: "up" | "down";
  /** overshoot-ratchet: which direction the cabal ratchets the oracle in.
   *  "up"   = ratchet upward (oracle drifts above real over time)
   *  "down" = ratchet downward (oracle drifts below real over time)
   *  Quote mode: identical to withholder (abstain on against-direction obs).
   *  Nudge mode: pool-poison every block + adaptive author strategy:
   *    - oracle-already-overshot-past-ceiling : freeze (avoid giving back gains)
   *    - oracle-on-or-below-target            : activate ALL in-direction bumps
   *      regardless of real motion (always inject; never let real correct). */
  overshootRatchetDirection?: "up" | "down";
  /** overshoot-ratchet: ceiling on the cumulative deviation the cabal lets
   *  build up before they freeze. Expressed as a multiple of ε. Default 200
   *  (≈ 2/3 of one maxBlockDelta). Higher = bolder attack, more likely to
   *  trip criterion 2 (max single-block deviation) but more givebacks; lower
   *  = stealthier ratchet. */
  overshootRatchetCeilingBumps?: number;
  /** stealth-withholder: bias direction (oracle is suppressed FROM moving
   *  this way, so the oracle drifts opposite to real over up-trends if "up").
   *  - "up": abstain when observed > lastPrice * (1 + threshold). Real moves
   *          up are frozen, so oracle drifts BELOW real over up-trends.
   *  - "down": abstain when observed < lastPrice * (1 - threshold). Real
   *          moves down are frozen, so oracle drifts ABOVE real over down-runs.
   *  Per the round-3 design, the cabal MUST be configured with priceSource
   *  jitterStdDev=0 so that all members observe identical real prices and
   *  abstain in lock-step. Stochastic per-validator jitter would defeat the
   *  whole point — it'd let a fraction of cabal abstain on non-freeze blocks,
   *  re-exposing them to the wideband-confidence ABSENT_PENALTY path. */
  stealthWithholderDirection?: "up" | "down";
  /** stealth-withholder: minimum normalized move (|observed-lastPrice|/lastPrice)
   *  in the bias direction before the cabal abstains. Smaller threshold →
   *  more freezes, stronger attack, but threshold must exceed jitter stddev
   *  to avoid sign-flips across cabal. With recommended jitterStdDev=0 setup
   *  any threshold ≥ 0 is fine; default 0.0005 (0.05%) gives near-maximum
   *  freeze rate while still requiring observed to actually be above
   *  lastPrice (avoids spurious abstentions when the oracle is already
   *  ahead of real). */
  stealthAbstainThreshold?: number;
  /** convergent-cabal: bias direction (oracle is suppressed FROM moving this
   *  way; oracle drifts opposite to real over up-trends if "up"). */
  convergentCabalDirection?: "up" | "down";
  /** convergent-cabal: trend window (blocks). The cabal only abstains when
   *  real has been moving in the bias direction for this many CONSECUTIVE
   *  recent blocks (per the cabal member's lockstep observation history).
   *  Longer window = rarer abstention = lower absent-penalty exposure but
   *  weaker attack. */
  convergentCabalTrendBlocks?: number;
  /** convergent-cabal: minimum cumulative real move in bias direction over
   *  the trend window (fraction of lastPrice) required to trigger abstention.
   *  Combined with `convergentCabalTrendBlocks`, ensures the cabal only
   *  spends absent-penalty budget when the trend is real and significant. */
  convergentCabalTrendMagnitude?: number;
  /** convergent-cabal: nudge-mode author ceiling, in units of ε. Same
   *  semantics as `overshootRatchetCeilingBumps`. */
  convergentCabalCeilingBumps?: number;
  /** inband-shifter: bias direction. "up" = ratchet oracle upward.
   *  Quote leg submits `lastPrice * (1 + biasSign * quoteBias)`; nudge leg
   *  pool-poisons this direction every block. */
  inbandShifterDirection?: "up" | "down";
  /** inband-shifter: quote-leg per-block bias as a fraction of `lastPrice`,
   *  applied in `inbandShifterDirection`. Must lie strictly inside the
   *  defender's wideband `goodBand` (5%) so the cabal never accrues a
   *  BAD_QUOTE_PENALTY — the whole point of the attack is to be invisible
   *  to defense #1's quote-distance check. Default 0.04 (4%). */
  inbandShifterQuoteBias?: number;
  /** inband-shifter: nudge-mode author ceiling, in units of ε. Same shape
   *  as `overshootRatchetCeilingBumps` but kept independent so each
   *  scenario can tune the two attackers without coupling them. Default 200. */
  inbandShifterCeilingBumps?: number;
}

export interface ValidatorGroup {
  type: ValidatorType;
  count: number;
  priceSource: ValidatorPriceSource;
  params?: ValidatorParams;
}

// ── Submissions / inherent ──────────────────────────────────────────────────
// A single validator's input for a block. Aggregators consume an array of these
// (after the block author has picked which to include in the inherent).
//   "nudge"   : signed direction only (used by nudge aggregator)
//   "quote"   : absolute price (used by median / mean)
//   "abstain" : validator opted not to submit
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
  authorType: ValidatorType;
  totalBumps: number;
  activatedBumps: number;
  netDirection: number; // positive = up, negative = down
  /** Number of non-abstain submissions the author placed in the inherent. */
  inherentTotal: number;
  /** Of `inherentTotal`, how many came from non-honest validators. */
  inherentNonHonest: number;
  /** Convenience: 100 × inherentNonHonest / inherentTotal. 0 if empty. */
  inherentNonHonestPct: number;
  /** True iff the aggregator computed a fresh price this block. False when
   *  the minInputs gate fired (or the inherent was empty) and the runtime
   *  held `lastPrice`. */
  priceUpdated: boolean;
  deviation: number; // absolute difference real - oracle
  deviationPct: number; // percentage deviation
  /** Sampled confidence vector, populated only on every Nth block (see
   *  CONFIDENCE_SAMPLE_INTERVAL). One entry per validator, in [0, 1].
   *  null on non-sampled blocks AND when the aggregator has confidence
   *  tracking disabled. */
  confidenceSnapshot?: Float32Array | null;
}

// ── SimulationConfig ────────────────────────────────────────────────────────
// `validators` is required. `aggregator` and `realPrice` have engine defaults.
export interface SimulationConfig {
  startDate: string;
  endDate: string;
  validators: ValidatorGroup[];
  seed: number;
  convergenceThreshold: number; // % deviation threshold for "converged"
  label: string;
  /** Aggregation rule + per-aggregator params. Default applied in engine. */
  aggregator?: AggregatorConfig;
  /** How the ground-truth real price is produced. Default applied in engine. */
  realPrice?: RealPriceSpec;
}

export interface SimulationResult {
  config: SimulationConfig;
  summary: SimulationSummary;
}

export interface SimulationSummary {
  /// Total number of blocks in the simulation
  totalBlocks: number;
  /// Aggregation rule that produced this run.
  aggregator: AggregatorMode;
  /// The resolved epsilon value used in the simulation. Only meaningful when
  /// aggregator === "nudge"; 0 / "abs" for the quote aggregators.
  epsilon: number;
  epsilonMode: EpsilonMode;
  /// Convergence threshold (in %) and the resulting rate.
  convergenceThreshold: number;
  convergenceRate: number;
  /// Mean / max deviation across the simulation.
  meanDeviation: number;
  meanDeviationPct: number;
  maxDeviation: number;
  maxDeviationPct: number;
  /// The integral of the deviation over time.
  deviationIntegral: number;
  /// The maximum rate of deviation change.
  maxDeviationRate: number;
  /// Longest consecutive streak of blocks where deviationPct >= threshold.
  maxConsecutiveBlocksAboveThreshold: number;
  /// Distribution tails of deviationPct.
  p95DeviationPct: number;
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
  /** Optional: sparse confidence samples for this chunk. `tick` indexes are
   *  block offsets within the chunk (0..blockCount-1). Each entry of
   *  `samples` is a length-N array (one per validator). Absent when the
   *  scenario didn't track confidence. */
  confidenceSamples?: { ticks: number[]; samples: number[][] };
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
  /** When confidence tracking was on, this is the per-validator-index type
   *  string (e.g. ["honest", "honest", ..., "withholder", ...]). Used by the
   *  UI's confidence tab to label/colour validators. Absent when off. */
  validatorTypes?: ValidatorType[];
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

// ── Confidence API ──
export interface ConfidenceSeries {
  /** Validator index, or -1 to indicate a per-type aggregate. */
  validatorIndex: number;
  type: ValidatorType;
  /** Optional label for aggregates (e.g. "honest aggregate"). */
  label?: string;
  points: LinePoint[];
}

export interface ApiConfidenceResponse {
  scenarioIndex: number;
  from: number;
  to: number;
  /** Type aggregates (always present, one per type with at least one validator). */
  typeAggregates: ConfidenceSeries[];
  /** Per-validator series (only when explicitly requested). */
  perValidator?: ConfidenceSeries[];
  /** Validator index → type mapping for the whole scenario. */
  validatorTypes: ValidatorType[];
}

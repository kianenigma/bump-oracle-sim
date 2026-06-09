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
//   "median" : validators submit absolute price quotes; runtime sorts and
//              takes the median of the inherent.
//   "latched-median" : like median but with NO minInputs. The aggregator
//              keeps each validator's last submitted quote ("latches" it) and
//              every block re-takes the median over the full latched set
//              (the inherent only refreshes the latches of the validators it
//              contains). A validator that goes quiet keeps influencing the
//              price with its stale latch until it submits again.
export type AggregatorMode = "nudge" | "median" | "latched-median";

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
//                                          Polkadot's 2/3-honest assumption,
//                                          so the median is protected)
// Defaults are resolved by the engine once it knows N.
//
// `velocity` (nudge only, scenario-file feature; not wired through the CLI):
// optional pair of "ε-schedule" policies — one for blocks where the proposal
// is UP, one for DOWN. The aggregator stores an immutable `baseEpsilon` and a
// per-block `currentEpsilon`. Each policy declares:
//   - `nextEpsilonCoefficient(agreementRate, baseEpsilon)` — at end of block
//     N, returns a multiplier on baseEpsilon. Stored as the pending proposal.
//   - `agreementGate(agreementRate)` — evaluated in N+1's `onBeforeApply`,
//     against N+1's OWN agreement rate (computed from the block's inherent).
//     True ⇒ N+1's currentEpsilon = baseEpsilon × coefficient.
//     False ⇒ N+1's currentEpsilon = baseEpsilon (reset to base).
// Non-compounding: every block lands on either baseEpsilon or
// baseEpsilon × coefficient — never on previousEpsilon × coefficient. The
// boost is also gated by the block author opting in via `wantVelocityBoost`
// AND by a direction-match check (current block's net direction must
// equal the pending proposal's direction).
//
// Functions can't be JSON-cloned, so velocity-enabled scenarios run on the
// main thread (the worker pool drops them silently).
export interface VelocityPolicy {
  /** End-of-block-N hook. Inputs:
   *    - `agreementRate` ∈ [0, 1] = |Σ bumps| / validatorCount for the block
   *      that just ended. The denominator is the FULL validator set (not
   *      the inherent), so abstentions and author-side trimming dilute the
   *      rate — the policy sees true network consensus, not the author's
   *      editorial view.
   *    - `baseEpsilon` — the aggregator's immutable base ε (in the same
   *      unit as `epsilonMode`: absolute step in `"abs"`, per-bump fraction
   *      of price in `"ratio"`). The returned coefficient multiplies THIS
   *      base, not the previous block's possibly-boosted ε — the schedule
   *      is non-compounding.
   *  Returns a multiplier; 1.0 = no proposed change. */
  nextEpsilonCoefficient: (agreementRate: number, baseEpsilon: number) => number;
  /** Evaluated in the NEXT block's `onBeforeApply` against THAT block's own
   *  agreement rate (same |Σ bumps| / validatorCount semantics). True =
   *  consume the proposal: currentEpsilon = baseEpsilon × coefficient.
   *  False = reset: currentEpsilon = baseEpsilon. */
  agreementGate: (agreementRate: number) => boolean;
}

export interface VelocityConfig {
  /** Policy applied when the block pushed the oracle price upward. */
  up: VelocityPolicy;
  /** Policy applied when the block pushed the oracle price downward. */
  down: VelocityPolicy;
}

export type AggregatorConfig =
  | { kind: "nudge"; epsilon: EpsilonSpec; minInputs?: number; velocity?: VelocityConfig }
  | { kind: "median"; minInputs?: number }
  | { kind: "latched-median" };

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
  | { kind: "synthetic"; venues: VenueId[]; venueJitterStdDev: number; moveBlocks?: number[] };

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

/** Structural shape of one entry in the synthetic event span list. Defined
 *  here (rather than in `src/data/synthetic.ts`) so `ResolvedPriceSource` can
 *  carry it without a circular import. The runtime producer lives in
 *  synthetic.ts and the consumer (writer/server) treats it as opaque data. */
export interface SyntheticEventSpanLite {
  index: number;
  descriptor: {
    direction: "drop" | "increase";
    magnitude: number;
    variant: "insync-r20" | "insync-r50" | "insync-r90" | "diverge";
    recovery: number;
    moveBlocks?: number;
  };
  moveStartBlock: number;
  extremeBlock: number;
  recoveryStartBlock: number;
  recoveredBlock: number;
  postEndBlock: number;
  startPrice: number;
  extremePrice: number;
  recoveredPrice: number;
}

/** What `loadPriceSource` returns: the resolved 6s price grid plus, when in
 *  trades mode, per-venue carry-forward-filled price arrays of the same length.
 *  When in synthetic mode the source also carries an event-span list so the
 *  chart can label each hovered block with the event it belongs to. */
export interface ResolvedPriceSource {
  pricePoints: PricePoint[];
  venuePrices?: Record<VenueId, number[]>;
  /** Per-venue, per-block base-asset volume aligned with `pricePoints` and
   *  `venuePrices`. Present only in trades mode (synthetic and candle modes
   *  have no notion of per-venue volume). Zero in blocks where a venue had
   *  no trades — NOT carried forward. Surfaces in the UI's per-venue volume
   *  chart and is what cross-venue VWAP weighs by. */
  venueVolumes?: Record<VenueId, number[]>;
  events?: SyntheticEventSpanLite[];
}

// ── Validator groups ────────────────────────────────────────────────────────
// Each group is a (type, count, priceSource, params) tuple. Replaces the
// old top-level (validatorCount, validatorMix, jitterStdDev,
// validatorPriceSource, maliciousParams) bundle. A simulation's full
// validator set is the concatenation of all groups, in order.
export type ValidatorType =
  "honest" | "malicious" | "pushy" | "pushy-max" | "noop" | "delayed" | "drift";

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
}

export interface ValidatorGroup {
  type: ValidatorType;
  count: number;
  priceSource: ValidatorPriceSource;
  params?: ValidatorParams;
}

// ── Submissions / inherent ──────────────────────────────────────────────────
// A single validator's input for a block. Aggregators consume an array of
// these (after the block author has picked which to include in the inherent).
//   "nudge" : signed direction only (used by nudge aggregator)
//   "quote" : absolute price (used by median)
// A validator that wants to abstain returns `null` from `produceInput` (or
// omits the entry from its `produceInherent` output) — there is no explicit
// abstain submission kind in the protocol.
//
// Every submission carries its producer's `type` so the block author can
// reason about who sent what — e.g. a cabal author can identify its fellow
// cabal members in the gossip pool and override their votes when selecting
// the inherent. The type is purely informational from the protocol's point
// of view; the aggregator's price math ignores it.
export type Submission =
  | { kind: "nudge"; validatorIndex: number; type: ValidatorType; bump: Bump }
  | { kind: "quote"; validatorIndex: number; type: ValidatorType; price: number };

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
  /** Validator index whose quote was selected as the median for this block.
   *  Defined only when the aggregator is median-mode AND `priceUpdated` is
   *  true; undefined for nudge mode or freeze blocks. */
  medianValidatorIndex?: number;
  /** Type of the validator at `medianValidatorIndex`. Only set under the same
   *  conditions. Used by the CSV and the chart tooltip. */
  medianValidatorType?: ValidatorType;
  /** |Σ bumps| / validatorCount, ∈ [0, 1]. Denominator is the full validator
   *  set (NOT the inherent) — abstentions and author trimming dilute the
   *  rate so the value reflects network consensus rather than the author's
   *  editorial view. Always set by the nudge aggregator (0 when the inherent
   *  is empty or perfectly balanced). Undefined for median. Surfaces in the
   *  hover tooltip when the scenario uses a velocity-enabled nudge
   *  aggregator (otherwise it doesn't drive anything). */
  agreementRate?: number;
  /** currentEpsilon / baseEpsilon for THIS block. Only set when the nudge
   *  aggregator has a velocity schedule configured — without one, the value
   *  would always be 1.0. The tooltip uses this to expose when the velocity
   *  gate fired (coefficient ≠ 1) on a hovered block. */
  epsilonCoefficient?: number;
  /** Per-block list of every submission in the inherent — populated for both
   *  median (quote) and nudge (bump) modes. Each entry is a discriminated
   *  union: `{ kind: "quote", type, price }` or `{ kind: "nudge", type, bump }`,
   *  where `bump` is the signed integer (Bump.Up = +1, Bump.Down = -1). Used
   *  exclusively by the CSV writer; not persisted to the chunked .simdata
   *  format. */
  inherentVotes?: Array<
    | { kind: "quote"; type: ValidatorType; price: number }
    | { kind: "nudge"; type: ValidatorType; bump: Bump }
  >;
  deviation: number; // absolute difference real - oracle
  deviationPct: number; // percentage deviation
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
  /** Output option (not a sim parameter): write the per-block `<dir>.csv`
   *  alongside the chunked data. Off by default — the CSV is large and only
   *  the block-detail page's full inherent vote list needs it. Set from the
   *  CLI `--csv` flag; carried on the config so it survives the worker
   *  postMessage to the parallel pool. */
  writeCsv?: boolean;
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
  /** Per-block flag: 1 if the aggregator computed a fresh price, 0 if the
   *  minInputs gate fired and the price was held. Optional for backward
   *  compatibility with simdata directories produced before this field was
   *  added — readers should default to 1 (assume update) when absent. */
  priceUpdated?: number[];
  /** Number of non-abstain submissions in the inherent each block. Optional
   *  for backward compat. */
  inherentTotals?: number[];
  /** Validator index whose quote was the median, per block. -1 means "not
   *  applicable" (nudge mode or freeze block). Optional for backward compat. */
  medianValidatorIndices?: number[];
  /** Per-block agreement rate (|net|/inherent.length) for the nudge
   *  aggregator. -1 means "not applicable" (median mode or empty inherent).
   *  Optional for backward compat. */
  agreementRates?: number[];
  /** Per-block epsilon coefficient (currentEpsilon/baseEpsilon) for the
   *  nudge aggregator when a velocity schedule is configured. -1 means "not
   *  applicable" (median mode, or nudge without velocity). Optional for
   *  backward compat. */
  epsilonCoefficients?: number[];
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
  /** Per-venue base-asset volume lines, present only when the .simdata was
   *  produced from trade data AND venues.json includes the `volumes` field
   *  (i.e. not older legacy directories). Same downsampling window as
   *  `venues`, but each bucket is a SUM across the constituent 6s blocks
   *  rather than the last value — volume is additive over time. */
  venueVolumes?: Record<string, LinePoint[]>;
}

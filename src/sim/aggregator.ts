import type { AggregatorConfig, ConfidencePolicy, Submission } from "../types.js";

/**
 * The block author has already trimmed `inputs` down to `inherent`.
 * The aggregator just applies it. This mirrors the runtime side of the
 * spec: the runtime never sees individual gossiped inputs — only the
 * inherent the author chose to include.
 *
 * `inputs` is also threaded through so we can report total-vs-activated
 * counts on BlockMetrics, but the aggregator's price math only ever
 * looks at `inherent`.
 */
export interface AggregatorContext {
  inputs: Submission[];      // all gossiped (for metrics only)
  inherent: Submission[];    // author's selection — drives price math
  lastPrice: number;
  epsilon: number;           // 0 for non-nudge aggregators
}

export interface AggregateOutcome {
  newPrice: number;
  totalBumps: number;
  activatedBumps: number;
  netDirection: number;
  /** False iff the aggregator deliberately held `lastPrice` because the
   *  inherent did not satisfy `minInputs` (or was empty). True on every
   *  path where the runtime actually computed a fresh price — even if
   *  the freshly computed value happens to equal `lastPrice`. */
  priceUpdated: boolean;
}

export interface Aggregator {
  readonly mode: "nudge" | "median" | "mean";
  readonly inputKind: "nudge" | "quote";
  apply(ctx: AggregatorContext): AggregateOutcome;
  /** Read-only snapshot of the current per-validator confidence vector.
   *  Length === validatorCount. All-1.0 for aggregators with no tracking. */
  confidenceSnapshot(): Float32Array;
  /** True iff this aggregator is updating per-validator confidence at all. */
  readonly tracksConfidence: boolean;
}

// ── Confidence callback ─────────────────────────────────────────────────────
/** Mutates `state` in place. Constants live inside the function — different
 *  policies are different functions, not different parameter bags. */
export type ConfidenceUpdate = (
  state: Float32Array,
  inputs: Submission[],
  inherent: Submission[],
  finalPrice: number,
  validatorCount: number,
) => void;

// Tuned so a 1/3-saturated withholder reaches 0 in ~100 blocks (~10 min wall)
// and recovery from 0 → 1 (when permanentExclusion is off) takes ~100
// cooperating blocks. Same order of magnitude in both directions: a few bad
// quotes can't sink a validator, but persistent misbehaviour does.
const GOOD_BAND_PCT      = 0.01;  // ±1% of finalPrice = "good" quote
const REWARD_DELTA       = 0.01;  // additive when good
const BAD_QUOTE_PENALTY  = 0.05;  // additive when outside band
const ABSENT_PENALTY     = 0.01;  // additive when not in inherent

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export const defaultConfidenceUpdate: ConfidenceUpdate = (state, _inputs, inherent, finalPrice, N) => {
  // Mark which validators showed up in the inherent.
  const present = new Uint8Array(N);
  // Also remember each present validator's submission for the distance check.
  // N is small (~300), so a dense lookup beats repeated find().
  const priceByIdx = new Float64Array(N);
  for (const s of inherent) {
    if (s.kind === "quote") {
      present[s.validatorIndex] = 1;
      priceByIdx[s.validatorIndex] = s.price;
    } else if (s.kind === "nudge") {
      present[s.validatorIndex] = 1;
      // nudge mode: the callback is a noop in nudge aggregator anyway, but
      // if a hybrid scenario ever wires this in, treat nudge as "present
      // but not scored on distance" — neutral.
      priceByIdx[s.validatorIndex] = finalPrice;
    }
  }

  const band = GOOD_BAND_PCT * Math.abs(finalPrice);
  for (let v = 0; v < N; v++) {
    if (state[v] === 0) continue; // already excluded; permanentExclusion enforces this at the apply() level
    if (!present[v]) {
      state[v] = clamp01(state[v] - ABSENT_PENALTY);
      continue;
    }
    const dist = Math.abs(priceByIdx[v] - finalPrice);
    state[v] = clamp01(state[v] + (dist <= band ? REWARD_DELTA : -BAD_QUOTE_PENALTY));
  }
};

export const noopConfidenceUpdate: ConfidenceUpdate = () => { /* deliberately empty */ };

function resolveConfidence(policy: ConfidencePolicy | undefined): { update: ConfidenceUpdate; on: boolean } {
  if (policy === "default") return { update: defaultConfidenceUpdate, on: true };
  return { update: noopConfidenceUpdate, on: false };
}

// ── NudgeAggregator ─────────────────────────────────────────────────────────
// price' = lastPrice + (Σ activated bumps) × ε.
// `inputs` carries everyone's gossiped nudges (for the totalBumps metric);
// `inherent` is the author's selection — only those count toward the price.
//
// `minInputs` defaults to 0 — a sparse inherent already holds price naturally
// (net = 0 → no bump). The knob is exposed for symmetry with the quote
// aggregators, not because nudge needs it.
export class NudgeAggregator implements Aggregator {
  readonly mode = "nudge" as const;
  readonly inputKind = "nudge" as const;
  readonly tracksConfidence = false;
  private readonly _confidence: Float32Array;

  constructor(private minInputs: number = 0, validatorCount: number = 0) {
    if (minInputs < 0) throw new Error(`nudge minInputs must be ≥ 0, got ${minInputs}`);
    this._confidence = new Float32Array(validatorCount);
    this._confidence.fill(1);
  }

  confidenceSnapshot(): Float32Array {
    return new Float32Array(this._confidence);
  }

  apply(ctx: AggregatorContext): AggregateOutcome {
    let totalBumps = 0;
    for (const s of ctx.inputs) if (s.kind === "nudge") totalBumps++;

    let nudgeCount = 0;
    for (const s of ctx.inherent) if (s.kind === "nudge") nudgeCount++;
    if (nudgeCount < this.minInputs) {
      return { newPrice: ctx.lastPrice, totalBumps, activatedBumps: 0, netDirection: 0, priceUpdated: false };
    }

    let net = 0;
    let activated = 0;
    for (const s of ctx.inherent) {
      if (s.kind !== "nudge") continue;
      net += s.bump; // Up=+1, Down=-1
      activated++;
    }
    return {
      newPrice: ctx.lastPrice + net * ctx.epsilon,
      totalBumps,
      activatedBumps: activated,
      netDirection: net,
      priceUpdated: true,
    };
  }
}

// Sort, trim `floor(n × k)` from each tail, return [trimmedSorted, trimCount].
// If trimming would empty the set, falls back to no-trim (caller decides what
// to do with the unmodified sorted array).
function sortAndTrim(quotes: number[], k: number): { sorted: number[]; trim: number } {
  quotes.sort((a, b) => a - b);
  const trim = Math.floor(quotes.length * k);
  return quotes.length - 2 * trim <= 0
    ? { sorted: quotes, trim: 0 }
    : { sorted: quotes, trim };
}

// ── ConfidenceTrackingMixin (shared state for median + mean) ───────────────
// Holds the per-validator `confidence` Float32Array and the sticky `excluded`
// Uint8Array, plus the configured callback and exclusion policy. Subclasses
// call `filterByConfidence()` to drop excluded inherent entries, then
// `updateConfidence()` after computing the final price.
abstract class ConfidenceTrackingAggregator {
  protected readonly confidence: Float32Array;
  protected readonly excluded: Uint8Array;
  protected readonly N: number;

  constructor(
    validatorCount: number,
    protected readonly permanentExclusion: boolean,
    protected readonly confidenceUpdate: ConfidenceUpdate,
    public readonly tracksConfidence: boolean,
  ) {
    this.N = validatorCount;
    this.confidence = new Float32Array(validatorCount);
    this.confidence.fill(1);
    this.excluded = new Uint8Array(validatorCount);
  }

  confidenceSnapshot(): Float32Array {
    return new Float32Array(this.confidence);
  }

  protected isExcluded(v: number): boolean {
    if (this.permanentExclusion && this.excluded[v]) return true;
    return this.confidence[v] === 0;
  }

  /** Drop excluded validators from the inherent quote stream. */
  protected filterByConfidence(inherent: Submission[]): Submission[] {
    if (!this.tracksConfidence) return inherent;
    const out: Submission[] = [];
    for (const s of inherent) {
      if (s.kind === "abstain") continue;
      if (this.isExcluded(s.validatorIndex)) continue;
      out.push(s);
    }
    return out;
  }

  /** Active validator set size = N − count(excluded). */
  protected activeCount(): number {
    if (!this.tracksConfidence) return this.N;
    let n = this.N;
    for (let v = 0; v < this.N; v++) {
      if (this.isExcluded(v)) n--;
    }
    return n;
  }

  /** Run the configured callback, then sticky-mark anything that hit zero. */
  protected updateConfidence(
    inputs: Submission[],
    inherent: Submission[],
    finalPrice: number,
  ): void {
    if (!this.tracksConfidence) return;
    this.confidenceUpdate(this.confidence, inputs, inherent, finalPrice, this.N);
    if (this.permanentExclusion) {
      for (let v = 0; v < this.N; v++) {
        if (this.confidence[v] === 0) this.excluded[v] = 1;
      }
    }
  }
}

// ── MedianAggregator ────────────────────────────────────────────────────────
// Optionally trims top/bottom k% of the inherent quotes by value, then takes
// the median of what remains. Empty inherent → hold price.
//
// With confidence tracking on: validators with confidence=0 (or sticky-
// excluded under permanentExclusion) are filtered out before the trim/median.
// `minInputs` is rescaled down to floor(2/3 · activeCount) + 1 so a shrunk
// active set stays live.
//
// Metric semantics (matches the nudge aggregator):
//   totalBumps     = quotes gossiped (count in `inputs`)        — pre-author
//   activatedBumps = quotes that contributed to the median      — post-trim
// The gap surfaces author-side censorship in the block metrics.
export class MedianAggregator extends ConfidenceTrackingAggregator implements Aggregator {
  readonly mode = "median" as const;
  readonly inputKind = "quote" as const;

  constructor(
    private k: number = 0,
    private minInputs: number = 0,
    validatorCount: number = 0,
    permanentExclusion: boolean = true,
    confidenceUpdate: ConfidenceUpdate = noopConfidenceUpdate,
    tracksConfidence: boolean = false,
  ) {
    super(validatorCount, permanentExclusion, confidenceUpdate, tracksConfidence);
    if (k < 0 || k >= 0.5) throw new Error(`median k must be in [0, 0.5), got ${k}`);
    if (minInputs < 0) throw new Error(`median minInputs must be ≥ 0, got ${minInputs}`);
  }

  apply(ctx: AggregatorContext): AggregateOutcome {
    const totalQuotes = countQuotes(ctx.inputs);
    const filtered = this.filterByConfidence(ctx.inherent);
    const quotes = collectQuotes(filtered);
    const effectiveMinInputs = this.tracksConfidence
      ? Math.min(this.minInputs, Math.floor((2 / 3) * this.activeCount()) + 1)
      : this.minInputs;
    if (quotes.length < effectiveMinInputs || quotes.length === 0) {
      return { newPrice: ctx.lastPrice, totalBumps: totalQuotes, activatedBumps: 0, netDirection: 0, priceUpdated: false };
    }
    const { sorted, trim } = sortAndTrim(quotes, this.k);
    const newPrice = medianOfRange(sorted, trim, sorted.length - trim);
    this.updateConfidence(ctx.inputs, filtered, newPrice);
    return {
      newPrice,
      totalBumps: totalQuotes,
      activatedBumps: quotes.length - 2 * trim,
      netDirection: Math.sign(newPrice - ctx.lastPrice),
      priceUpdated: true,
    };
  }
}

// ── MeanAggregator ──────────────────────────────────────────────────────────
// Optionally trims top/bottom k% by value, then arithmetic mean of survivors.
// k=0 is a plain mean across all quotes. If trimming would empty the set,
// falls back to median(all) so the price still updates.
//
// `weighted=true` uses each survivor's confidence as its weight in the mean.
// (Only meaningful when confidence tracking is on.)
//
// Metric semantics: same as median — totalBumps is pre-author gossip,
// activatedBumps is the post-trim contributing count.
export class MeanAggregator extends ConfidenceTrackingAggregator implements Aggregator {
  readonly mode = "mean" as const;
  readonly inputKind = "quote" as const;

  constructor(
    private k: number = 0,
    private minInputs: number = 0,
    validatorCount: number = 0,
    permanentExclusion: boolean = true,
    confidenceUpdate: ConfidenceUpdate = noopConfidenceUpdate,
    tracksConfidence: boolean = false,
    private weighted: boolean = false,
  ) {
    super(validatorCount, permanentExclusion, confidenceUpdate, tracksConfidence);
    if (k < 0 || k >= 0.5) throw new Error(`mean k must be in [0, 0.5), got ${k}`);
    if (minInputs < 0) throw new Error(`mean minInputs must be ≥ 0, got ${minInputs}`);
  }

  apply(ctx: AggregatorContext): AggregateOutcome {
    const totalQuotes = countQuotes(ctx.inputs);
    const filtered = this.filterByConfidence(ctx.inherent);

    // Need both prices and indices for the weighted variant.
    const quoteEntries: Array<{ price: number; idx: number }> = [];
    for (const s of filtered) {
      if (s.kind === "quote") quoteEntries.push({ price: s.price, idx: s.validatorIndex });
    }

    const effectiveMinInputs = this.tracksConfidence
      ? Math.min(this.minInputs, Math.floor((2 / 3) * this.activeCount()) + 1)
      : this.minInputs;
    if (quoteEntries.length < effectiveMinInputs || quoteEntries.length === 0) {
      return { newPrice: ctx.lastPrice, totalBumps: totalQuotes, activatedBumps: 0, netDirection: 0, priceUpdated: false };
    }

    // Trim by value. We need to keep idx aligned to price for the weighted
    // variant, so sort the entries themselves.
    quoteEntries.sort((a, b) => a.price - b.price);
    const n = quoteEntries.length;
    const trim = quoteEntries.length - 2 * Math.floor(n * this.k) <= 0
      ? 0
      : Math.floor(n * this.k);
    const lo = trim;
    const hi = n - trim;

    let newPrice: number;
    if (this.weighted && this.tracksConfidence) {
      let wsum = 0;
      let weight = 0;
      for (let i = lo; i < hi; i++) {
        const w = this.confidence[quoteEntries[i].idx];
        wsum += quoteEntries[i].price * w;
        weight += w;
      }
      // weight could be 0 if all survivors hit confidence=0 in the same call.
      newPrice = weight > 0 ? wsum / weight : ctx.lastPrice;
    } else {
      let sum = 0;
      for (let i = lo; i < hi; i++) sum += quoteEntries[i].price;
      newPrice = sum / (hi - lo);
    }

    this.updateConfidence(ctx.inputs, filtered, newPrice);
    return {
      newPrice,
      totalBumps: totalQuotes,
      activatedBumps: hi - lo,
      netDirection: Math.sign(newPrice - ctx.lastPrice),
      priceUpdated: true,
    };
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Polkadot assumes ≥ 2/3 honest validators. Requiring `floor(2/3·N) + 1`
 *  inputs to update guarantees that more than half of the contributing
 *  data points come from honest validators, protecting median (and bounding
 *  the influence on mean). For nudge, the natural default is 0. */
export function defaultMinInputs(kind: AggregatorConfig["kind"], validatorCount: number): number {
  if (kind === "nudge") return 0;
  return Math.floor((2 / 3) * validatorCount) + 1;
}

export function makeAggregator(cfg: AggregatorConfig, validatorCount: number): Aggregator {
  const minInputs = cfg.minInputs ?? defaultMinInputs(cfg.kind, validatorCount);
  switch (cfg.kind) {
    case "nudge":
      return new NudgeAggregator(minInputs, validatorCount);
    case "median": {
      const { update, on } = resolveConfidence(cfg.confidence);
      const permanent = cfg.permanentExclusion ?? true;
      return new MedianAggregator(cfg.k ?? 0, minInputs, validatorCount, permanent, update, on);
    }
    case "mean": {
      const { update, on } = resolveConfidence(cfg.confidence);
      const permanent = cfg.permanentExclusion ?? true;
      const weighted = cfg.weighted ?? false;
      return new MeanAggregator(cfg.k ?? 0, minInputs, validatorCount, permanent, update, on, weighted);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function collectQuotes(submissions: Submission[]): number[] {
  const out: number[] = [];
  for (const s of submissions) if (s.kind === "quote") out.push(s.price);
  return out;
}

function countQuotes(submissions: Submission[]): number {
  let n = 0;
  for (const s of submissions) if (s.kind === "quote") n++;
  return n;
}

/** Median of `sorted[lo, hi)`. Caller guarantees lo < hi. */
function medianOfRange(sorted: number[], lo: number, hi: number): number {
  const n = hi - lo;
  if (n === 0) return 0;
  const mid = lo + Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

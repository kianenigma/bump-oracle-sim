import { Bump, type AggregatorConfig, type AggregatorMode, type EpsilonMode, type Submission, type VelocityConfig } from "../types.js";
import type { InputKind } from "./validator.js";

/**
 * The block author has already trimmed `inputs` down to `inherent`.
 * The aggregator just applies it. This mirrors the runtime side of the
 * spec: the runtime never sees individual gossiped inputs — only the
 * inherent the author chose to include.
 *
 * `inputs` is also threaded through so we can report total-vs-activated
 * counts on BlockMetrics, but the aggregator's price math only ever
 * looks at `inherent`.
 *
 * Note: any per-block aggregator parameter (e.g. ε) lives on the aggregator
 * instance itself, NOT on this context. The aggregator owns its state across
 * the run and may mutate it block-to-block (e.g. an adaptive ε schedule).
 */
export interface AggregatorContext {
  inputs: Submission[];      // all gossiped (for metrics only)
  inherent: Submission[];    // author's selection — drives price math
  lastPrice: number;
  /** Total validator count for THIS run — the denominator used by the nudge
   *  aggregator when computing agreement rate. Using the full validator set
   *  (rather than the inherent size) means abstentions and author-side
   *  trimming dilute the rate, which is the consensus signal we actually
   *  care about: how much of the network agreed on a direction this block. */
  validatorCount: number;
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
  /** Validator index whose quote was selected as the median (only for the
   *  median aggregator on `priceUpdated=true` blocks). For an even-count
   *  inherent the median is the average of two adjacent quotes; we report
   *  the *upper* of the two. Undefined for nudge or freeze blocks. */
  medianValidatorIndex?: number;
  /** |Σ bumps| / validatorCount, ∈ [0, 1]. 1 = every validator agreed on a
   *  direction AND the author kept them all; lower values reflect any mix of
   *  abstentions, opposing votes, or author-side trimming. The denominator is
   *  the FULL validator set (not the inherent), so the rate measures network
   *  consensus rather than the author's editorial view. 0 either means
   *  "perfectly balanced" or "no contribution this block" — consumers
   *  disambiguate via `activatedBumps` / `inherentTotal`. Always set by the
   *  nudge aggregator; undefined for median. */
  agreementRate?: number;
  /** currentEpsilon / baseEpsilon for THIS block. 1.0 when no velocity boost
   *  fired (or when no velocity schedule is configured), > 1.0 (or whatever
   *  the schedule returned) when the gate fired this block. Only emitted by
   *  the nudge aggregator and only when a velocity config is present —
   *  otherwise the value would always be 1.0 and just adds noise. */
  epsilonCoefficient?: number;
}

export interface Aggregator {
  /** Aggregator family. Determines what kind of submission validators must
   *  produce and what shape of inherent the chain expects. */
  readonly mode: AggregatorMode;
  apply(ctx: AggregatorContext): AggregateOutcome;
  /** Build the per-block `InputKind` variant for `ProduceCtx`. Carries any
   *  aggregator-owned parameters validators need for THIS block — e.g.
   *  nudge's effective ε — so per-block aggregator state stays inside the
   *  aggregator instance. */
  inputKindFor(lastPrice: number): InputKind;
  /** Runs AFTER the author builds the inherent and BEFORE `apply`. Lets
   *  the aggregator finalize any per-block state that depends on the
   *  inherent's shape (e.g. nudge's velocity gate check uses the current
   *  block's agreement rate). Median's implementation is a no-op. */
  onBeforeApply(ctx: BeforeApplyContext): void;
  /** End-of-block hook. Chain calls this after `apply` and before metric
   *  collection, so aggregators can update internal state (e.g. nudge's
   *  velocity schedule — proposing the next-block coefficient) from the
   *  block's outcome. */
  onBlockEnd(ctx: BlockEndContext): void;
}

/** Context passed to `Aggregator.onBeforeApply`. */
export interface BeforeApplyContext {
  /** Author-selected inherent. */
  inherent: Submission[];
  /** True iff the block author opted in to consume any pending velocity
   *  proposal this block (via the optional `wantVelocityBoost` method).
   *  Default `false` — most validators don't implement the method. */
  wantBoost: boolean;
  /** Total validator count — agreement-rate denominator. See the same field
   *  on `AggregatorContext` for the rationale. */
  validatorCount: number;
}

/** Context passed to `Aggregator.onBlockEnd` at the end of every block. */
export interface BlockEndContext {
  /** Oracle price BEFORE this block's update. */
  oldPrice: number;
  /** Oracle price AFTER this block's update. */
  newPrice: number;
  /** The author-selected inherent that drove this block's price math. */
  inherent: Submission[];
  /** Total validator count — agreement-rate denominator for the next-block
   *  proposal. See the same field on `AggregatorContext`. */
  validatorCount: number;
}

/**
 * Strict input-kind check. Every aggregator only understands one `Submission`
 * shape (nudge or quote). Encountering any other kind in `inputs` or
 * `inherent` is a misconfiguration (typically: an attacker class compatible
 * with one engine being run under the other), so we throw a standard error
 * rather than silently dropping the rogue submission.
 *
 * Abstention is modelled as the absence of a submission, not a third kind,
 * so the kind comparison is exhaustive.
 */
function assertSubmissionKind(
  s: Submission,
  expected: "nudge" | "quote",
  where: "inputs" | "inherent",
  mode: AggregatorMode,
): void {
  if (s.kind === expected) return;
  throw new Error(
    `${mode} aggregator: expected '${expected}' submissions in ${where} but got ` +
    `'${s.kind}' from validator ${s.validatorIndex}. ` +
    `This is almost always a (validator, engine) mismatch — check the validator ` +
    `class's static compatibleEngines list.`,
  );
}

// ── NudgeAggregator ─────────────────────────────────────────────────────────
// price' = lastPrice + (Σ activated bumps) × ε.
// `inputs` carries everyone's gossiped nudges (for the totalBumps metric);
// `inherent` is the author's selection — only those count toward the price.
//
// ε is owned by this class. It can be stored as either an absolute step
// (`epsilonMode === "abs"`) or as a fraction of the current price
// (`epsilonMode === "ratio"`, effective = lastPrice · ε). Both `epsilon` and
// `epsilonMode` are mutable so future logic can evolve ε across the run
// (e.g. tightening it as the chain converges).
//
// `minInputs` defaults to 0 — a sparse inherent already holds price naturally
// (net = 0 → no bump). The knob is exposed for symmetry with the quote
// aggregator, not because nudge needs it. It is checked against the size of
// the inherent, NOT against `inputs` — gossip volume must not influence the
// aggregator's decision.
export class NudgeAggregator implements Aggregator {
  readonly mode = "nudge" as const;

  private minInputs: number;
  /** Configured base ε. Never written after construction. `currentEpsilon`
   *  resets to this value at the start of every block (in `onBeforeApply`)
   *  unless the velocity boost fires. */
  protected readonly baseEpsilon: number;
  /** ε used for THIS block's price math. Set per-block in `onBeforeApply`:
   *  either equals `baseEpsilon` (no boost) or `baseEpsilon × coefficient`
   *  (gate fired). Never compounds past one coefficient — every block
   *  starts the gate decision fresh from `baseEpsilon`. */
  protected currentEpsilon: number;
  protected epsilonMode: EpsilonMode;
  /** Optional ε-schedule. When unset, ε stays constant across the run. */
  private velocity?: VelocityConfig;
  /** Coefficient proposed at end of the previous block, awaiting THIS
   *  block's gate decision in `onBeforeApply`. */
  private pendingProposal: { direction: "up" | "down"; coefficient: number } | null = null;

  constructor(minInputs: number, epsilon: number, epsilonMode: EpsilonMode, velocity?: VelocityConfig) {
    if (minInputs < 0) throw new Error(`nudge minInputs must be ≥ 0, got ${minInputs}`);
    if (epsilon < 0) throw new Error(`nudge epsilon must be ≥ 0, got ${epsilon}`);
    this.minInputs = minInputs;
    this.baseEpsilon = epsilon;
    this.currentEpsilon = epsilon;
    this.epsilonMode = epsilonMode;
    this.velocity = velocity;
  }

  /** Read the immutable base ε. Used by engine-level summary persistence
   *  so the recorded `epsilon` is the configured base, not a transient
   *  boosted currentEpsilon. */
  getBaseEpsilon(): number {
    return this.baseEpsilon;
  }

  /** Scale `currentEpsilon` for ratio mode — used by `apply`. */
  private effectiveCurrentEpsilon(lastPrice: number): number {
    return this.epsilonMode === "ratio" ? lastPrice * this.currentEpsilon : this.currentEpsilon;
  }

  /** Scale `baseEpsilon` for ratio mode — used by `inputKindFor` so the
   *  ε we advertise to validators is in the same unit as the rest of the
   *  block-time numbers. */
  private effectiveBaseEpsilon(lastPrice: number): number {
    return this.epsilonMode === "ratio" ? lastPrice * this.baseEpsilon : this.baseEpsilon;
  }

  inputKindFor(lastPrice: number): InputKind {
    // Always advertise BASE ε to validators (the conservative, pre-boost
    // value). Authors that want to plan for the boost read `velocity` and
    // compute scenarios themselves.
    const baseEps = this.effectiveBaseEpsilon(lastPrice);
    if (!this.velocity) return { kind: "nudge", epsilon: baseEps };
    return {
      kind: "nudge",
      epsilon: baseEps,
      velocity: {
        baseEpsilon: baseEps,
        pendingProposal: this.pendingProposal,
        config: this.velocity,
      },
    };
  }

  /** Velocity gate: evaluates against the just-built inherent. The boost
   *  fires iff ALL of:
   *    1. A pending proposal exists (from previous block's `onBlockEnd`).
   *    2. The block author opted in via `wantVelocityBoost`.
   *    3. M3: the inherent's net direction matches `proposal.direction`.
   *    4. `policy.agreementGate(rate)` returns true.
   *  Otherwise `currentEpsilon` resets to `baseEpsilon`. The pending
   *  proposal is always consumed (cleared) at the end. */
  onBeforeApply(ctx: BeforeApplyContext): void {
    if (!this.velocity) return; // no schedule → currentEpsilon stays at base
    const proposal = this.pendingProposal;
    this.pendingProposal = null;
    this.currentEpsilon = this.baseEpsilon; // default outcome: reset

    if (proposal === null || !ctx.wantBoost) return;
    if (ctx.inherent.length === 0) return;
    if (ctx.validatorCount === 0) return;

    let net = 0;
    for (const s of ctx.inherent) {
      if (s.kind !== "nudge") return; // unreachable: enforced by apply()
      net += s.bump;
    }
    // Denominator is total validators, NOT inherent size: abstentions and
    // author-side trimming must dilute the rate so the gate reflects true
    // network consensus, not the author's editorial choice.
    const rate = Math.abs(net) / ctx.validatorCount;
    // M3: a flat block (net = 0) can never confirm an up/down proposal.
    const currentDir: "up" | "down" | null =
      net > 0 ? "up" :
        net < 0 ? "down" : null;
    if (currentDir === null || currentDir !== proposal.direction) return;

    const policy = this.velocity[proposal.direction];
    if (policy.agreementGate(rate)) {
      this.currentEpsilon = this.baseEpsilon * proposal.coefficient;
    }
  }

  /** End-of-block: propose a coefficient for the NEXT block based on this
   *  block's direction-of-motion and agreement rate. The proposal will be
   *  gate-checked in the next block's `onBeforeApply`. The coefficient
   *  multiplies BASE ε (non-compounding). */
  onBlockEnd(ctx: BlockEndContext): void {
    if (!this.velocity) return;
    if (ctx.inherent.length === 0 || ctx.validatorCount === 0) {
      this.pendingProposal = null;
      return;
    }

    let net = 0;
    for (const s of ctx.inherent) {
      if (s.kind !== "nudge") return; // unreachable: enforced by apply()
      net += s.bump;
    }
    // Same denominator change as `onBeforeApply` — see comment there.
    const agreementRate = Math.abs(net) / ctx.validatorCount;
    const direction: "up" | "down" | null =
      ctx.newPrice > ctx.oldPrice ? "up" :
        ctx.newPrice < ctx.oldPrice ? "down" : null;
    if (direction === null) {
      this.pendingProposal = null;
      return;
    }
    const coeff = this.velocity[direction].nextEpsilonCoefficient(agreementRate, this.baseEpsilon);
    this.pendingProposal = coeff !== 1 ? { direction, coefficient: coeff } : null;
  }

  apply(ctx: AggregatorContext): AggregateOutcome {
    for (const s of ctx.inputs) assertSubmissionKind(s, "nudge", "inputs", this.mode);
    for (const s of ctx.inherent) assertSubmissionKind(s, "nudge", "inherent", this.mode);

    // Gossip-volume metric (informational only; never gates minInputs).
    const totalBumps = ctx.inputs.length;

    // Compute net + agreementRate up-front so both the freeze path and the
    // update path emit the same diagnostics. Denominator is total validators
    // (not inherent size) so abstentions and author trimming dilute the rate
    // — matches the gate's view of network-wide consensus. Empty inherent
    // (with non-zero validatorCount) → 0; UI hides when inherentTotal === 0.
    let net = 0;
    for (const s of ctx.inherent) {
      if (s.kind !== "nudge") continue; // unreachable: assertion above threw
      net += s.bump; // Up=+1, Down=-1
    }
    const agreementRate = ctx.validatorCount > 0 ? Math.abs(net) / ctx.validatorCount : 0;

    // Coefficient is emitted only when a velocity schedule exists — otherwise
    // it's constant 1.0 and would just clutter the per-block tooltip / chunk.
    // Guard against baseEpsilon === 0 (degenerate but legal): coefficient is
    // undefined in that case rather than NaN.
    const coefficient = this.velocity !== undefined && this.baseEpsilon !== 0
      ? this.currentEpsilon / this.baseEpsilon
      : undefined;

    if (ctx.inherent.length < this.minInputs) {
      return {
        newPrice: ctx.lastPrice, totalBumps, activatedBumps: 0, netDirection: 0, priceUpdated: false,
        agreementRate, epsilonCoefficient: coefficient,
      };
    }

    // Apply uses currentEpsilon, which `onBeforeApply` just set to either
    // baseEpsilon or baseEpsilon × coefficient depending on the gate.
    const eps = this.effectiveCurrentEpsilon(ctx.lastPrice);
    return {
      newPrice: ctx.lastPrice + net * eps,
      totalBumps,
      activatedBumps: ctx.inherent.length,
      netDirection: net,
      priceUpdated: true,
      agreementRate,
      epsilonCoefficient: coefficient,
    };
  }
}

// ── MedianAggregator ────────────────────────────────────────────────────────
// Sorts the inherent quotes by value and takes the median. Empty inherent or
// below-minInputs inherent → hold price.
//
// Metric semantics (matches the nudge aggregator):
//   totalBumps     = quotes gossiped (count in `inputs`)
//   activatedBumps = quotes in the inherent (contributed to the median)
// The gap surfaces author-side censorship in the block metrics.
export class MedianAggregator implements Aggregator {
  readonly mode = "median" as const;

  constructor(private minInputs: number = 0) {
    if (minInputs < 0) throw new Error(`median minInputs must be ≥ 0, got ${minInputs}`);
  }

  inputKindFor(_lastPrice: number): InputKind {
    return { kind: "quote", minInputs: this.minInputs };
  }

  /** Median has no per-block schedule; both hooks are no-ops. */
  onBeforeApply(_ctx: BeforeApplyContext): void { /* deliberately empty */ }
  onBlockEnd(_ctx: BlockEndContext): void { /* deliberately empty */ }

  apply(ctx: AggregatorContext): AggregateOutcome {
    for (const s of ctx.inputs) assertSubmissionKind(s, "quote", "inputs", this.mode);
    for (const s of ctx.inherent) assertSubmissionKind(s, "quote", "inherent", this.mode);

    const totalQuotes = ctx.inputs.length;
    const quoteEntries = collectQuoteEntries(ctx.inherent);
    if (quoteEntries.length < this.minInputs || quoteEntries.length === 0) {
      return { newPrice: ctx.lastPrice, totalBumps: totalQuotes, activatedBumps: 0, netDirection: 0, priceUpdated: false };
    }
    const { prices: sorted, indices: sortedIndices } = sortQuotesWithIndex(quoteEntries);
    const { value: newPrice, index: medianValidatorIndex } =
      medianOfRangeWithIndex(sorted, sortedIndices, 0, sorted.length);
    return {
      newPrice,
      totalBumps: totalQuotes,
      activatedBumps: sorted.length,
      netDirection: Math.sign(newPrice - ctx.lastPrice),
      priceUpdated: true,
      medianValidatorIndex,
    };
  }
}

// ── LatchedMedianAggregator ───────────────────────────────────────────────────
// Same price math as median (sort the values, take the middle one) but with
// two differences:
//   1. NO minInputs — the aggregator always has data to median once any
//      validator has ever submitted, so it never holds the price for want of
//      inputs (block 0 with an empty inherent is the lone exception).
//   2. State is LATCHED. The aggregator keeps the last quote each validator
//      submitted in `latched` (keyed by validatorIndex). Each block, the
//      inherent's quotes refresh the latches of the validators they contain;
//      the median is then taken over the FULL latched set — including the
//      stale latches of validators absent from this block's inherent.
//
// Consequence: a validator that submits once and then goes quiet keeps
// influencing the price with its stale value until it submits again. This is
// the key behavioural difference from plain median (which only ever sees the
// current block's inherent).
//
// Metric semantics mirror the other aggregators:
//   totalBumps     = quotes gossiped this block (count in `inputs`)
//   activatedBumps = quotes the author put in this block's inherent
// The median is over the latched set, which is generally larger than the
// inherent, so `medianValidatorIndex` may point at a validator that did not
// submit this block.
export class LatchedMedianAggregator implements Aggregator {
  readonly mode = "latched-median" as const;

  /** validatorIndex → that validator's most recently submitted quote price.
   *  Persists across blocks for the lifetime of the run. */
  private latched = new Map<number, number>();

  inputKindFor(_lastPrice: number): InputKind {
    // No minInputs: advertise 0 so author-side logic that reads it doesn't
    // gate on a threshold.
    return { kind: "quote", minInputs: 0 };
  }

  /** Latched-median has no per-block schedule; both hooks are no-ops. */
  onBeforeApply(_ctx: BeforeApplyContext): void { /* deliberately empty */ }
  onBlockEnd(_ctx: BlockEndContext): void { /* deliberately empty */ }

  apply(ctx: AggregatorContext): AggregateOutcome {
    for (const s of ctx.inputs) assertSubmissionKind(s, "quote", "inputs", this.mode);
    for (const s of ctx.inherent) assertSubmissionKind(s, "quote", "inherent", this.mode);

    const totalQuotes = ctx.inputs.length;

    // Refresh the latches of every validator present in this block's inherent.
    for (const s of ctx.inherent) {
      if (s.kind !== "quote") continue; // unreachable: asserted above
      this.latched.set(s.validatorIndex, s.price);
    }

    // No validator has ever submitted (e.g. block 0 with an empty inherent) —
    // nothing to median, hold the price.
    if (this.latched.size === 0) {
      return { newPrice: ctx.lastPrice, totalBumps: totalQuotes, activatedBumps: ctx.inherent.length, netDirection: 0, priceUpdated: false };
    }

    // Median over the FULL latched set (not just this block's inherent).
    const entries: Array<{ price: number; index: number }> = new Array(this.latched.size);
    let i = 0;
    for (const [index, price] of this.latched) entries[i++] = { price, index };
    const { prices: sorted, indices: sortedIndices } = sortQuotesWithIndex(entries);
    const { value: newPrice, index: medianValidatorIndex } =
      medianOfRangeWithIndex(sorted, sortedIndices, 0, sorted.length);
    return {
      newPrice,
      totalBumps: totalQuotes,
      activatedBumps: ctx.inherent.length,
      netDirection: Math.sign(newPrice - ctx.lastPrice),
      priceUpdated: true,
      medianValidatorIndex,
    };
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Polkadot assumes ≥ 2/3 honest validators. Requiring `floor(2/3·N) + 1`
 *  inputs to update guarantees that more than half of the contributing
 *  data points come from honest validators, protecting the median. For
 *  nudge, the natural default is 0; latched-median has no minInputs at all. */
export function defaultMinInputs(kind: AggregatorConfig["kind"], validatorCount: number): number {
  if (kind === "nudge" || kind === "latched-median") return 0;
  return Math.floor((2 / 3) * validatorCount) + 1;
}

/** Construct an `Aggregator` from its config. For nudge, the caller must
 *  pre-resolve any `"auto"` / ratio epsilon into a numeric value plus mode —
 *  the aggregator does not know about price data, so the engine resolves
 *  `EpsilonSpec` before instantiation. */
export function makeAggregator(
  cfg: AggregatorConfig,
  validatorCount: number,
  resolvedNudgeEpsilon?: { value: number; mode: EpsilonMode },
): Aggregator {
  switch (cfg.kind) {
    case "nudge": {
      if (resolvedNudgeEpsilon === undefined) {
        throw new Error("makeAggregator: nudge aggregator requires a resolved epsilon");
      }
      const minInputs = cfg.minInputs ?? defaultMinInputs("nudge", validatorCount);
      return new NudgeAggregator(
        minInputs,
        resolvedNudgeEpsilon.value,
        resolvedNudgeEpsilon.mode,
        cfg.velocity,
      );
    }
    case "median": {
      const minInputs = cfg.minInputs ?? defaultMinInputs("median", validatorCount);
      return new MedianAggregator(minInputs);
    }
    case "latched-median":
      // No minInputs — the latched set is always non-empty after block 0.
      return new LatchedMedianAggregator();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Sort by price (ascending) keeping each entry's original validator index
 *  paired. Returns parallel arrays so the median-rank entry's validatorIndex
 *  can be read out alongside its price. */
function sortQuotesWithIndex(entries: Array<{ price: number; index: number }>): { prices: number[]; indices: number[] } {
  entries.sort((a, b) => a.price - b.price);
  const prices = new Array<number>(entries.length);
  const indices = new Array<number>(entries.length);
  for (let i = 0; i < entries.length; i++) {
    prices[i] = entries[i].price;
    indices[i] = entries[i].index;
  }
  return { prices, indices };
}

/** Project the inherent (all guaranteed `quote` after the kind assertion)
 *  into a (price, validatorIndex) pair list. */
function collectQuoteEntries(submissions: Submission[]): Array<{ price: number; index: number }> {
  const out: Array<{ price: number; index: number }> = new Array(submissions.length);
  for (let i = 0; i < submissions.length; i++) {
    const s = submissions[i];
    if (s.kind !== "quote") continue; // unreachable: asserted by caller
    out[i] = { price: s.price, index: s.validatorIndex };
  }
  return out;
}

/** Median of `sorted[lo, hi)` returned alongside the validator index whose
 *  quote sits at the median rank. For even-count ranges (where the median is
 *  the average of two adjacent quotes) we report the upper of the two —
 *  arbitrary but consistent. Caller guarantees lo < hi. */
function medianOfRangeWithIndex(
  sorted: number[], sortedIndices: number[], lo: number, hi: number,
): { value: number; index: number } {
  const n = hi - lo;
  const mid = lo + Math.floor(n / 2);
  if (n % 2 === 1) return { value: sorted[mid], index: sortedIndices[mid] };
  return { value: (sorted[mid - 1] + sorted[mid]) / 2, index: sortedIndices[mid] };
}

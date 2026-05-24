import type { AggregatorConfig, EpsilonMode, Submission, VelocityConfig } from "../types.js";
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
}

export interface Aggregator {
  /** Aggregator family. Determines what kind of submission validators must
   *  produce and what shape of inherent the chain expects. */
  readonly mode: "nudge" | "median";
  apply(ctx: AggregatorContext): AggregateOutcome;
  /** Build the per-block `InputKind` variant for `ProduceCtx`. Carries any
   *  aggregator-owned parameters validators need for THIS block — e.g.
   *  nudge's effective ε — so per-block aggregator state stays inside the
   *  aggregator instance. */
  inputKindFor(lastPrice: number): InputKind;
  /** End-of-block hook. Chain calls this after the aggregator's `apply` and
   *  before metric collection, so aggregators can update internal state
   *  (e.g. nudge's velocity schedule) from the block's outcome. */
  onBlockEnd(ctx: BlockEndContext): void;
}

/** Context passed to `Aggregator.onBlockEnd` at the end of every block. */
export interface BlockEndContext {
  /** Oracle price BEFORE this block's update. */
  oldPrice: number;
  /** Oracle price AFTER this block's update. */
  newPrice: number;
  /** The author-selected inherent that drove this block's price math. */
  inherent: Submission[];
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
  mode: "nudge" | "median",
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
  /** Mutable so the velocity schedule can update it across blocks. */
  protected epsilon: number;
  protected epsilonMode: EpsilonMode;
  /** Optional ε-schedule. When unset, ε stays constant across the run. */
  private velocity?: VelocityConfig;
  /** Candidate coefficient proposed at end of the previous block. Activated
   *  this block iff the corresponding direction's `agreementGate` passes. */
  private pendingChange: { direction: "up" | "down"; coefficient: number } | null = null;

  constructor(minInputs: number, epsilon: number, epsilonMode: EpsilonMode, velocity?: VelocityConfig) {
    if (minInputs < 0) throw new Error(`nudge minInputs must be ≥ 0, got ${minInputs}`);
    if (epsilon < 0)   throw new Error(`nudge epsilon must be ≥ 0, got ${epsilon}`);
    this.minInputs = minInputs;
    this.epsilon = epsilon;
    this.epsilonMode = epsilonMode;
    this.velocity = velocity;
  }

  /** Resolve the per-bump step size for a given `lastPrice`. In `"abs"`
   *  mode it's just `epsilon`; in `"ratio"` mode it scales with the price. */
  private effectiveEpsilon(lastPrice: number): number {
    return this.epsilonMode === "ratio" ? lastPrice * this.epsilon : this.epsilon;
  }

  inputKindFor(lastPrice: number): InputKind {
    return { kind: "nudge", epsilon: this.effectiveEpsilon(lastPrice) };
  }

  /** Velocity schedule: two-block-confirmation ε update.
   *  1. If a candidate from the previous block is pending, gate-check it
   *     against THIS block's agreement rate. If the gate passes, multiply
   *     ε by the stored coefficient; either way, clear the candidate.
   *  2. Propose a fresh candidate from THIS block's direction-of-motion +
   *     agreement rate, to be confirmed at end of the next block.
   *  No-op when `velocity` is unset or the inherent is empty (no signal). */
  onBlockEnd(ctx: BlockEndContext): void {
    if (!this.velocity) return;
    if (ctx.inherent.length === 0) {
      this.pendingChange = null;
      return;
    }

    let net = 0;
    for (const s of ctx.inherent) {
      if (s.kind !== "nudge") return; // unreachable: enforced by apply()
      net += s.bump;
    }
    const agreementRate = Math.abs(net) / ctx.inherent.length;

    // Step 1: confirm/discard the previous block's candidate.
    if (this.pendingChange !== null) {
      const policy = this.velocity[this.pendingChange.direction];
      if (policy.agreementGate(agreementRate)) {
        this.epsilon *= this.pendingChange.coefficient;
      }
      this.pendingChange = null;
    }

    // Step 2: propose a new candidate from THIS block's direction.
    const direction: "up" | "down" | null =
      ctx.newPrice > ctx.oldPrice ? "up" :
      ctx.newPrice < ctx.oldPrice ? "down" : null;
    if (direction === null) return; // flat block — no proposal
    const coeff = this.velocity[direction].nextEpsilonCoefficient(agreementRate, this.epsilon);
    if (coeff !== 1) {
      this.pendingChange = { direction, coefficient: coeff };
    }
  }

  apply(ctx: AggregatorContext): AggregateOutcome {
    for (const s of ctx.inputs)   assertSubmissionKind(s, "nudge", "inputs",   this.mode);
    for (const s of ctx.inherent) assertSubmissionKind(s, "nudge", "inherent", this.mode);

    // Gossip-volume metric (informational only; never gates minInputs).
    const totalBumps = ctx.inputs.length;

    if (ctx.inherent.length < this.minInputs) {
      return { newPrice: ctx.lastPrice, totalBumps, activatedBumps: 0, netDirection: 0, priceUpdated: false };
    }

    let net = 0;
    for (const s of ctx.inherent) {
      if (s.kind !== "nudge") continue; // unreachable: assertion above threw
      net += s.bump; // Up=+1, Down=-1
    }
    const eps = this.effectiveEpsilon(ctx.lastPrice);
    return {
      newPrice: ctx.lastPrice + net * eps,
      totalBumps,
      activatedBumps: ctx.inherent.length,
      netDirection: net,
      priceUpdated: true,
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
    return { kind: "quote" };
  }

  /** Median has no per-block schedule; the hook is a no-op. */
  onBlockEnd(_ctx: BlockEndContext): void { /* deliberately empty */ }

  apply(ctx: AggregatorContext): AggregateOutcome {
    for (const s of ctx.inputs)   assertSubmissionKind(s, "quote", "inputs",   this.mode);
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

// ── Factory ─────────────────────────────────────────────────────────────────

/** Polkadot assumes ≥ 2/3 honest validators. Requiring `floor(2/3·N) + 1`
 *  inputs to update guarantees that more than half of the contributing
 *  data points come from honest validators, protecting the median. For
 *  nudge, the natural default is 0. */
export function defaultMinInputs(kind: AggregatorConfig["kind"], validatorCount: number): number {
  if (kind === "nudge") return 0;
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
  const minInputs = cfg.minInputs ?? defaultMinInputs(cfg.kind, validatorCount);
  switch (cfg.kind) {
    case "nudge": {
      if (resolvedNudgeEpsilon === undefined) {
        throw new Error("makeAggregator: nudge aggregator requires a resolved epsilon");
      }
      return new NudgeAggregator(
        minInputs,
        resolvedNudgeEpsilon.value,
        resolvedNudgeEpsilon.mode,
        cfg.velocity,
      );
    }
    case "median":
      return new MedianAggregator(minInputs);
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

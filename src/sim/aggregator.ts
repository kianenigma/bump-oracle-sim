import type { AggregatorConfig, Submission } from "../types.js";

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
  /** Validator index whose quote was selected as the median (only for the
   *  median aggregator on `priceUpdated=true` blocks). For an even-count
   *  inherent the median is the average of two adjacent quotes; we report
   *  the *upper* of the two. Undefined for nudge or freeze blocks. */
  medianValidatorIndex?: number;
}

export interface Aggregator {
  readonly mode: "nudge" | "median";
  readonly inputKind: "nudge" | "quote";
  apply(ctx: AggregatorContext): AggregateOutcome;
}

/**
 * Strict input-kind check. Every aggregator only understands one `Submission`
 * shape (nudge or quote) plus abstains. Encountering any other kind in `inputs`
 * or `inherent` is a misconfiguration (typically: an attacker class compatible
 * with one engine being run under the other), so we throw a standard error
 * rather than silently dropping the rogue submission.
 *
 * Abstains are always allowed — they represent a validator that chose not
 * to submit and contribute neither to `minInputs` nor to the price math.
 */
function assertSubmissionKind(
  s: Submission,
  expected: "nudge" | "quote",
  where: "inputs" | "inherent",
  mode: "nudge" | "median",
): void {
  if (s.kind === "abstain" || s.kind === expected) return;
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
// `minInputs` defaults to 0 — a sparse inherent already holds price naturally
// (net = 0 → no bump). The knob is exposed for symmetry with the quote
// aggregator, not because nudge needs it. It is checked against the size of
// the inherent (excluding abstains), NOT against `inputs` — gossip volume
// must not influence the aggregator's decision.
export class NudgeAggregator implements Aggregator {
  readonly mode = "nudge" as const;
  readonly inputKind = "nudge" as const;

  constructor(private minInputs: number = 0) {
    if (minInputs < 0) throw new Error(`nudge minInputs must be ≥ 0, got ${minInputs}`);
  }

  apply(ctx: AggregatorContext): AggregateOutcome {
    for (const s of ctx.inputs)   assertSubmissionKind(s, "nudge", "inputs",   this.mode);
    for (const s of ctx.inherent) assertSubmissionKind(s, "nudge", "inherent", this.mode);

    // Gossip-volume metric (informational only; never gates minInputs).
    let totalBumps = 0;
    for (const s of ctx.inputs) if (s.kind === "nudge") totalBumps++;

    // After the assertion above, every non-abstain inherent entry IS a nudge.
    let inherentCount = 0;
    for (const s of ctx.inherent) if (s.kind === "nudge") inherentCount++;
    if (inherentCount < this.minInputs) {
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

// ── MedianAggregator ────────────────────────────────────────────────────────
// Optionally trims top/bottom k% of the inherent quotes by value, then takes
// the median of what remains. Empty inherent → hold price.
//
// Metric semantics (matches the nudge aggregator):
//   totalBumps     = quotes gossiped (count in `inputs`)        — pre-author
//   activatedBumps = quotes that contributed to the median      — post-trim
// The gap surfaces author-side censorship in the block metrics.
export class MedianAggregator implements Aggregator {
  readonly mode = "median" as const;
  readonly inputKind = "quote" as const;

  constructor(
    private k: number = 0,
    private minInputs: number = 0,
  ) {
    if (k < 0 || k >= 0.5) throw new Error(`median k must be in [0, 0.5), got ${k}`);
    if (minInputs < 0) throw new Error(`median minInputs must be ≥ 0, got ${minInputs}`);
  }

  apply(ctx: AggregatorContext): AggregateOutcome {
    for (const s of ctx.inputs)   assertSubmissionKind(s, "quote", "inputs",   this.mode);
    for (const s of ctx.inherent) assertSubmissionKind(s, "quote", "inherent", this.mode);

    const totalQuotes = countQuotes(ctx.inputs);
    const quoteEntries = collectQuoteEntries(ctx.inherent);
    if (quoteEntries.length < this.minInputs || quoteEntries.length === 0) {
      return { newPrice: ctx.lastPrice, totalBumps: totalQuotes, activatedBumps: 0, netDirection: 0, priceUpdated: false };
    }
    const { prices: sorted, indices: sortedIndices } = sortQuotesWithIndex(quoteEntries);
    const trim = Math.floor(sorted.length * this.k);
    const trimmedTrim = (sorted.length - 2 * trim <= 0) ? 0 : trim;
    const lo = trimmedTrim;
    const hi = sorted.length - trimmedTrim;
    const { value: newPrice, index: medianValidatorIndex } = medianOfRangeWithIndex(sorted, sortedIndices, lo, hi);
    return {
      newPrice,
      totalBumps: totalQuotes,
      activatedBumps: hi - lo,
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

export function makeAggregator(cfg: AggregatorConfig, validatorCount: number): Aggregator {
  const minInputs = cfg.minInputs ?? defaultMinInputs(cfg.kind, validatorCount);
  switch (cfg.kind) {
    case "nudge":
      return new NudgeAggregator(minInputs);
    case "median":
      return new MedianAggregator(cfg.k ?? 0, minInputs);
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

/** Like collectQuotes but keeps each quote paired with its validatorIndex
 *  so we can report which validator's quote became the median. */
function collectQuoteEntries(submissions: Submission[]): Array<{ price: number; index: number }> {
  const out: Array<{ price: number; index: number }> = [];
  for (const s of submissions) if (s.kind === "quote") out.push({ price: s.price, index: s.validatorIndex });
  return out;
}

function countQuotes(submissions: Submission[]): number {
  let n = 0;
  for (const s of submissions) if (s.kind === "quote") n++;
  return n;
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

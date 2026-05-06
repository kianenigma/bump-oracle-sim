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
}

export interface Aggregator {
  readonly mode: "nudge" | "median" | "mean";
  readonly inputKind: "nudge" | "quote";
  apply(ctx: AggregatorContext): AggregateOutcome;
}

// ── NudgeAggregator ─────────────────────────────────────────────────────────
// price' = lastPrice + (Σ activated bumps) × ε.
// `inputs` carries everyone's gossiped nudges (for the totalBumps metric);
// `inherent` is the author's selection — only those count toward the price.
export class NudgeAggregator implements Aggregator {
  readonly mode = "nudge" as const;
  readonly inputKind = "nudge" as const;

  apply(ctx: AggregatorContext): AggregateOutcome {
    let totalBumps = 0;
    for (const s of ctx.inputs) if (s.kind === "nudge") totalBumps++;

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

// ── MedianAggregator ────────────────────────────────────────────────────────
// Optionally trims top/bottom k% of the inherent quotes by value, then takes
// the median of what remains. Empty inherent → hold price.
export class MedianAggregator implements Aggregator {
  readonly mode = "median" as const;
  readonly inputKind = "quote" as const;

  constructor(private k: number = 0) {
    if (k < 0 || k >= 0.5) throw new Error(`median k must be in [0, 0.5), got ${k}`);
  }

  apply(ctx: AggregatorContext): AggregateOutcome {
    const quotes = collectQuotes(ctx.inherent);
    if (quotes.length === 0) {
      return { newPrice: ctx.lastPrice, totalBumps: 0, activatedBumps: 0, netDirection: 0 };
    }
    const { sorted, trim } = sortAndTrim(quotes, this.k);
    const newPrice = medianOfRange(sorted, trim, sorted.length - trim);
    return {
      newPrice,
      totalBumps: quotes.length,
      activatedBumps: quotes.length - 2 * trim,
      netDirection: Math.sign(newPrice - ctx.lastPrice),
    };
  }
}

// ── MeanAggregator ──────────────────────────────────────────────────────────
// Optionally trims top/bottom k% by value, then arithmetic mean of survivors.
// k=0 is a plain mean across all quotes. If trimming would empty the set,
// falls back to median(all) so the price still updates.
export class MeanAggregator implements Aggregator {
  readonly mode = "mean" as const;
  readonly inputKind = "quote" as const;

  constructor(private k: number = 0) {
    if (k < 0 || k >= 0.5) throw new Error(`mean k must be in [0, 0.5), got ${k}`);
  }

  apply(ctx: AggregatorContext): AggregateOutcome {
    const quotes = collectQuotes(ctx.inherent);
    if (quotes.length === 0) {
      return { newPrice: ctx.lastPrice, totalBumps: 0, activatedBumps: 0, netDirection: 0 };
    }
    const { sorted, trim } = sortAndTrim(quotes, this.k);
    const lo = trim;
    const hi = sorted.length - trim;
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += sorted[i];
    const newPrice = sum / (hi - lo);
    return {
      newPrice,
      totalBumps: quotes.length,
      activatedBumps: hi - lo,
      netDirection: Math.sign(newPrice - ctx.lastPrice),
    };
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function makeAggregator(cfg: AggregatorConfig): Aggregator {
  switch (cfg.kind) {
    case "nudge":  return new NudgeAggregator();
    case "median": return new MedianAggregator(cfg.k ?? 0);
    case "mean":   return new MeanAggregator(cfg.k ?? 0);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function collectQuotes(submissions: Submission[]): number[] {
  const out: number[] = [];
  for (const s of submissions) if (s.kind === "quote") out.push(s.price);
  return out;
}

/** Median of `sorted[lo, hi)`. Caller guarantees lo < hi. */
function medianOfRange(sorted: number[], lo: number, hi: number): number {
  const n = hi - lo;
  if (n === 0) return 0;
  const mid = lo + Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

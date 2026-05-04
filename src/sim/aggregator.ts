import { Bump } from "../types.js";
import type { AggregatorConfig, BumpSubmission, Submission } from "../types.js";
import type { ValidatorAgent } from "./validator.js";

// Context handed to every aggregator on every block. The aggregator decides
// which fields it uses — e.g. NudgeAggregator is the only one that consults
// `author` and `epsilon`; MedianAggregator only looks at `submissions`.
export interface AggregatorContext {
  submissions: Submission[];
  lastPrice: number;
  author: ValidatorAgent;
  epsilon: number;
  blockIndex: number;
}

export interface AggregateOutcome {
  newPrice: number;
  // For BlockMetrics reporting. Only the nudge aggregator produces meaningful
  // values here; others report 0 / 0.
  totalBumps: number;
  activatedBumps: number;
  netDirection: number;
}

export interface Aggregator {
  /** Tag used in summaries and labels. Mirrors AggregatorConfig.kind. */
  readonly mode: "nudge" | "median" | "trimmed-mean";
  /** What submission shape this aggregator expects validators to produce. */
  readonly submissionKind: "nudge" | "quote";
  aggregate(ctx: AggregatorContext): AggregateOutcome;
}

// ── NudgeAggregator ─────────────────────────────────────────────────────────
// Faithful port of the original chain.ts arithmetic. Validators emit Up/Down
// nudges; the block author picks a subset; the runtime adds (net × ε).
export class NudgeAggregator implements Aggregator {
  readonly mode = "nudge" as const;
  readonly submissionKind = "nudge" as const;

  aggregate(ctx: AggregatorContext): AggregateOutcome {
    const bumps: BumpSubmission[] = [];
    for (const s of ctx.submissions) {
      if (s.kind === "nudge") bumps.push({ validatorIndex: s.validatorIndex, bump: s.bump });
    }
    const mask = ctx.author.producePrice(bumps, ctx.lastPrice, ctx.epsilon, ctx.blockIndex);
    let net = 0;
    let activated = 0;
    for (let i = 0; i < bumps.length; i++) {
      if (mask[i]) {
        net += bumps[i].bump; // Up=+1, Down=-1
        activated++;
      }
    }
    return {
      newPrice: ctx.lastPrice + net * ctx.epsilon,
      totalBumps: bumps.length,
      activatedBumps: activated,
      netDirection: net,
    };
  }
}

// ── MedianAggregator ────────────────────────────────────────────────────────
// Validators submit absolute price quotes; runtime takes the median. Robust to
// outliers up to (but not including) 50% adversarial validators. With zero
// quotes (e.g. all-noop), price is held.
export class MedianAggregator implements Aggregator {
  readonly mode = "median" as const;
  readonly submissionKind = "quote" as const;

  aggregate(ctx: AggregatorContext): AggregateOutcome {
    const quotes = collectQuotes(ctx.submissions);
    if (quotes.length === 0) {
      return { newPrice: ctx.lastPrice, totalBumps: 0, activatedBumps: 0, netDirection: 0 };
    }
    quotes.sort((a, b) => a - b);
    const newPrice = median(quotes);
    return {
      newPrice,
      totalBumps: quotes.length,
      activatedBumps: quotes.length,
      netDirection: Math.sign(newPrice - ctx.lastPrice),
    };
  }
}

// ── TrimmedMeanAggregator ───────────────────────────────────────────────────
// Validators submit absolute price quotes; runtime drops the top `k` and
// bottom `k` by value, then averages the rest. `k` is a fraction of the total
// number of submissions per side (e.g. k=0.1 with 100 quotes drops 10 high
// and 10 low). If trimming would empty the set, falls back to median.
export class TrimmedMeanAggregator implements Aggregator {
  readonly mode = "trimmed-mean" as const;
  readonly submissionKind = "quote" as const;

  constructor(private k: number) {
    if (k < 0 || k >= 0.5) throw new Error(`trimmed-mean k must be in [0, 0.5), got ${k}`);
  }

  aggregate(ctx: AggregatorContext): AggregateOutcome {
    const quotes = collectQuotes(ctx.submissions);
    if (quotes.length === 0) {
      return { newPrice: ctx.lastPrice, totalBumps: 0, activatedBumps: 0, netDirection: 0 };
    }
    quotes.sort((a, b) => a - b);
    const trim = Math.floor(quotes.length * this.k);
    const remaining = quotes.length - 2 * trim;
    let newPrice: number;
    if (remaining <= 0) {
      newPrice = median(quotes);
    } else {
      let sum = 0;
      for (let i = trim; i < quotes.length - trim; i++) sum += quotes[i];
      newPrice = sum / remaining;
    }
    return {
      newPrice,
      totalBumps: quotes.length,
      activatedBumps: Math.max(0, quotes.length - 2 * trim),
      netDirection: Math.sign(newPrice - ctx.lastPrice),
    };
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function makeAggregator(cfg: AggregatorConfig): Aggregator {
  switch (cfg.kind) {
    case "nudge":        return new NudgeAggregator();
    case "median":       return new MedianAggregator();
    case "trimmed-mean": return new TrimmedMeanAggregator(cfg.k);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function collectQuotes(submissions: Submission[]): number[] {
  const out: number[] = [];
  for (const s of submissions) if (s.kind === "quote") out.push(s.price);
  return out;
}

/** Median of a pre-sorted ascending array. Caller must sort. */
function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

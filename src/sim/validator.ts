import { Bump } from "../types.js";
import type { Submission, ValidatorParams, ValidatorPriceSource, ValidatorType } from "../types.js";
import type { PriceEndpoint } from "./price-endpoint.js";

/** Per-block context handed to every produceInput / produceInherent call. */
export interface ProduceCtx {
  lastPrice: number;
  blockIndex: number;
  /** Effective epsilon for this block (already accounts for ratio mode).
   *  Only meaningful in nudge mode; quote-mode validators ignore it. */
  epsilon: number;
}

/** What kind of input an aggregator wants this block — drives produceInput. */
export type InputKind = "nudge" | "quote";

export interface ValidatorAgent {
  readonly index: number;
  readonly type: ValidatorType;
  readonly isHonest: boolean;

  /** This validator's local input for the block (gossiped to other nodes). */
  produceInput(inputKind: InputKind, ctx: ProduceCtx): Submission;

  /**
   * As block author: from all gossiped inputs, select the subset that
   * goes into the block inherent. The aggregator then applies that subset
   * to compute the new price.
   *
   * Nudge mode: returns the activated bumps (a subset of `inputs`).
   * Quote mode: default is pass-through (drop only abstains). Author-side
   *             attacks could selectively include — see TASKS.md §C.
   */
  produceInherent(inputs: Submission[], ctx: ProduceCtx): Submission[];
}

/**
 * Picks the integer n ∈ [0, maxBumps] that minimizes |absDiff − n × ε|.
 * Ties prefer fewer bumps (avoids flapping under jitter noise).
 */
export function optimalBumpCount(absDiff: number, epsilon: number, maxBumps: number): number {
  if (epsilon <= 0 || maxBumps <= 0) return 0;
  const base = Math.floor(absDiff / epsilon);
  if (base >= maxBumps) return maxBumps;

  const baseDev = absDiff - base * epsilon;
  const nextDev = (base + 1) * epsilon - absDiff;
  return nextDev < baseDev ? Math.min(base + 1, maxBumps) : base;
}

/** Filter out abstains; default quote-mode inherent is everyone else. */
export function passThroughQuotes(inputs: Submission[]): Submission[] {
  const out: Submission[] = [];
  for (const s of inputs) if (s.kind !== "abstain") out.push(s);
  return out;
}

/** Pick activated bumps from gossiped inputs — in-direction first, up to `n`. */
export function pickInDirectionBumps(
  inputs: Submission[],
  direction: Bump,
  maxActivated: number,
): Submission[] {
  const out: Submission[] = [];
  for (const s of inputs) {
    if (out.length >= maxActivated) break;
    if (s.kind === "nudge" && s.bump === direction) out.push(s);
  }
  return out;
}

// ── HonestValidator ─────────────────────────────────────────────────────────

export class HonestValidator implements ValidatorAgent {
  readonly index: number;
  readonly type: ValidatorType = "honest";
  readonly isHonest = true;
  protected endpoint: PriceEndpoint;
  protected rng: () => number;
  protected priceSource: ValidatorPriceSource;

  constructor(
    index: number,
    endpoint: PriceEndpoint,
    rng: () => number,
    priceSource: ValidatorPriceSource,
    _params: Required<ValidatorParams>,
  ) {
    this.index = index;
    this.endpoint = endpoint;
    this.rng = rng;
    this.priceSource = priceSource;
  }

  /** Validator's observation of the price at the given block. */
  protected observe(blockIndex: number): number {
    return this.endpoint.observe(this.priceSource, blockIndex, this.rng);
  }

  produceInput(inputKind: InputKind, ctx: ProduceCtx): Submission {
    const price = this.observe(ctx.blockIndex);
    if (inputKind === "nudge") {
      return { kind: "nudge", validatorIndex: this.index, bump: price >= ctx.lastPrice ? Bump.Up : Bump.Down };
    }
    return { kind: "quote", validatorIndex: this.index, price };
  }

  produceInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    if (inputs.length === 0) return [];
    if (inputs[0].kind === "quote" || inputs[0].kind === "abstain") {
      // Quote mode: honest pass-through.
      return passThroughQuotes(inputs);
    }
    // Nudge mode: target the local price, pick optimal in-direction bumps.
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const needed = optimalBumpCount(Math.abs(diff), ctx.epsilon, inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

import { Bump } from "../types.js";
import type { Submission, ValidatorParams, ValidatorPriceSource, ValidatorType } from "../types.js";
import type { PriceEndpoint } from "./price-endpoint.js";

/** What kind of input an aggregator wants this block. `"nudge-adaptive"`
 *  uses the same Submission shape as `"nudge"` (still bumps), but the
 *  aggregator's update rule is `delta = ε·n·|n|/V` instead of `delta = ε·n`,
 *  so the block author has to budget MORE bumps to hit the same target
 *  (sqrt scaling instead of linear). Validators look at this tag to pick
 *  the right author-side count. */
export type InputKind = "nudge" | "nudge-adaptive" | "quote";

/** Per-block context handed to every produceInput / produceInherent call. */
export interface ProduceCtx {
  lastPrice: number;
  blockIndex: number;
  /** Effective epsilon for this block (already accounts for ratio mode).
   *  Only meaningful in nudge-family modes; quote-mode validators ignore it. */
  epsilon: number;
  /** What kind of input the aggregator expects this block. Validators
   *  match on this to decide quote vs nudge vs adaptive-nudge behaviour. */
  inputKind: InputKind;
  /** Total active-validator count this block. Needed by the adaptive
   *  aggregator's author-side bump-count math (sqrt(|diff|·V/ε)) and by
   *  any future per-block compatibility check. */
  validatorCount: number;
}

export interface ValidatorAgent {
  readonly index: number;
  readonly type: ValidatorType;
  readonly isHonest: boolean;

  /** This validator's local input for the block (gossiped to other nodes). */
  produceInput(ctx: ProduceCtx): Submission;

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
 * Picks the integer n ∈ [0, maxBumps] that minimizes |absDiff − f(n)|, where
 * `f(n)` is the aggregator's per-block delta as a function of activated bumps:
 *
 *   - plain nudge          → f(n) = ε · n      (linear; chooses n ≈ absDiff/ε)
 *   - nudge-adaptive       → f(n) = ε · n²/V   (quadratic; chooses
 *                                              n ≈ √(absDiff·V/ε))
 *
 * The function reads `ctx.inputKind` and `ctx.validatorCount` to pick the
 * right inverse formula. Linear branch is the original behaviour; the
 * adaptive branch is what makes a 100%-honest run track real under the
 * adaptive aggregator (without it, the linear estimate under-corrects every
 * block because each bump only moves price by ε·|n|/V, not ε).
 *
 * Ties prefer fewer bumps (avoids flapping under jitter noise).
 */
export function optimalBumpCount(absDiff: number, ctx: ProduceCtx, maxBumps: number): number {
  const epsilon = ctx.epsilon;
  if (epsilon <= 0 || maxBumps <= 0) return 0;

  if (ctx.inputKind === "nudge-adaptive") {
    // f(n) = ε · n² / V. Ideal real-valued n is √(absDiff · V / ε); pick the
    // integer in [0, maxBumps] closest to that ideal.
    const V = ctx.validatorCount;
    if (V <= 0) return 0;
    const ideal = Math.sqrt((absDiff * V) / epsilon);
    const base = Math.floor(ideal);
    if (base >= maxBumps) return maxBumps;
    const baseDev = Math.abs(absDiff - (epsilon * base * base) / V);
    const nextDev = Math.abs(absDiff - (epsilon * (base + 1) * (base + 1)) / V);
    return nextDev < baseDev ? Math.min(base + 1, maxBumps) : base;
  }

  // Plain nudge: f(n) = ε · n.
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

  produceInput(ctx: ProduceCtx): Submission {
    const price = this.observe(ctx.blockIndex);
    // Both "nudge" and "nudge-adaptive" want bump submissions; only "quote"
    // wants the absolute price.
    if (ctx.inputKind === "nudge" || ctx.inputKind === "nudge-adaptive") {
      return { kind: "nudge", validatorIndex: this.index, bump: price >= ctx.lastPrice ? Bump.Up : Bump.Down };
    }
    return { kind: "quote", validatorIndex: this.index, price };
  }

  produceInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    if (inputs.length === 0) return [];
    if (ctx.inputKind === "quote") {
      return passThroughQuotes(inputs);
    }
    // Nudge mode: target the local price, pick optimal in-direction bumps.
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const needed = optimalBumpCount(Math.abs(diff), ctx, inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

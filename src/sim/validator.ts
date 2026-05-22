import { Bump } from "../types.js";
import type { AggregatorMode, Submission, ValidatorParams, ValidatorPriceSource, ValidatorType } from "../types.js";
import type { PriceEndpoint } from "./price-endpoint.js";

/** What kind of input an aggregator wants this block. Plain nudge submits
 *  Up/Down bumps; quote submits absolute prices. */
export type InputKind = "nudge" | "quote";

/** Per-block context handed to every produceInput / produceInherent call. */
export interface ProduceCtx {
  lastPrice: number;
  blockIndex: number;
  /** Effective epsilon for this block (already accounts for ratio mode).
   *  Only meaningful in nudge mode; quote-mode validators ignore it. */
  epsilon: number;
  /** What kind of input the aggregator expects this block. */
  inputKind: InputKind;
  /** Total validator count this block. Available for any per-block
   *  bump-count math. */
  validatorCount: number;
}

export interface ValidatorAgent {
  readonly index: number;
  readonly type: ValidatorType;
  readonly isHonest: boolean;

  /** This validator's local input for the block (gossiped to other nodes).
   *  Returns `null` to abstain — there is no explicit abstain submission. */
  produceInput(ctx: ProduceCtx): Submission | null;

  /**
   * As block author: from all gossiped inputs, select the subset that
   * goes into the block inherent. The aggregator then applies that subset
   * to compute the new price.
   *
   * Nudge mode: returns the activated bumps (a subset of `inputs`).
   * Quote mode: default is pass-through. Author-side attacks may
   *             selectively include — see TASKS.md §C.
   */
  produceInherent(inputs: Submission[], ctx: ProduceCtx): Submission[];
}

/** Constructor contract every validator class satisfies. The static
 *  `compatibleEngines` field declares which aggregator modes this validator
 *  is meaningful under — the engine consults it before any sim runs. */
export interface ValidatorConstructor {
  readonly compatibleEngines: ReadonlyArray<AggregatorMode>;
  new (
    index: number,
    endpoint: PriceEndpoint,
    rng: () => number,
    priceSource: ValidatorPriceSource,
    params: Required<ValidatorParams>,
  ): ValidatorAgent;
}

/**
 * Picks the integer n ∈ [0, maxBumps] closest to absDiff/ε (the inverse of the
 * plain-nudge update rule price' = lastPrice + n·ε). Ties prefer fewer bumps
 * to avoid flapping under jitter noise.
 */
export function optimalBumpCount(absDiff: number, ctx: ProduceCtx, maxBumps: number): number {
  const epsilon = ctx.epsilon;
  if (epsilon <= 0 || maxBumps <= 0) return 0;
  const base = Math.floor(absDiff / epsilon);
  if (base >= maxBumps) return maxBumps;
  const baseDev = absDiff - base * epsilon;
  const nextDev = (base + 1) * epsilon - absDiff;
  return nextDev < baseDev ? Math.min(base + 1, maxBumps) : base;
}

/** Default quote-mode author selection: pass every gossiped submission
 *  through untouched. Author-side attacks override this to drop or reorder. */
export function passThroughQuotes(inputs: Submission[]): Submission[] {
  return inputs.slice();
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
  static readonly compatibleEngines: ReadonlyArray<AggregatorMode> = ["nudge", "median"];

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
    if (ctx.inputKind === "nudge") {
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

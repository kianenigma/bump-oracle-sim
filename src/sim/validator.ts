import { Bump } from "../types.js";
import type { AggregatorMode, Submission, ValidatorParams, ValidatorPriceSource, ValidatorType, VelocityConfig } from "../types.js";
import type { PriceEndpoint } from "./price-endpoint.js";

/** What kind of input the aggregator expects this block. A tagged variant —
 *  `nudge` carries the effective ε for THIS block (always = base ε at
 *  this point; the velocity boost, if any, is decided later in
 *  `onBeforeApply` based on the author's inherent and opt-in choice).
 *  `quote` carries nothing. Validators discriminate on `.kind` and access
 *  `.epsilon` only in the nudge branch. */
export type InputKind =
  | {
      kind: "nudge";
      /** Per-bump step size advertised to all validators for this block.
       *  Equal to `velocity.baseEpsilon` when a schedule is configured —
       *  we hand validators the conservative pre-boost value. Authors
       *  that opt into the boost reason via `velocity` directly and
       *  compute bump counts using `baseEpsilon × coefficient`. */
      epsilon: number;
      /** Present iff the aggregator is running a velocity schedule.
       *  Snapshot of the schedule's per-block state so the AUTHOR can
       *  weigh the boost: predict the agreement rate their inherent will
       *  produce, run `config[dir].agreementGate(rate)` to know if the
       *  gate would fire, and pick the bump count + opt-in accordingly. */
      velocity?: {
        /** Immutable base ε for this run, scaled identically to the
         *  top-level `epsilon` field above (i.e. `lastPrice × ratio` in
         *  ratio mode, raw value in abs mode). Equal to `epsilon`. */
        baseEpsilon: number;
        /** Coefficient proposed at end of the previous block, awaiting
         *  this block's gate decision. `null` when no proposal is
         *  pending — the boost can't fire. */
        pendingProposal: { direction: "up" | "down"; coefficient: number } | null;
        /** Active velocity policy — gate predicates plus next-coefficient
         *  proposers for up and down. Authors call these directly to
         *  simulate "what if I push agreement to r?". */
        config: VelocityConfig;
      };
    }
  | { kind: "quote", minInputs: number };

/** Per-block context handed to every produceInput / produceInherent call. */
export interface ProduceCtx {
  lastPrice: number;
  blockIndex: number;
  /** Engine-mode tag carrying any mode-specific knobs for this block. */
  inputKind: InputKind;
  /** Total validator count this block. Available for any per-block */
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

  /** Optional. Invoked ONLY on the block author, after `produceInherent`
   *  and before the aggregator's `apply`. Returns whether the author opts
   *  to consume the pending velocity proposal this block. Validators that
   *  don't implement this default to `false` — i.e. they never trigger
   *  the velocity boost. The aggregator additionally enforces an M3
   *  direction-match check and runs the gate predicate; opting in is a
   *  necessary-but-not-sufficient condition. */
  wantVelocityBoost?(inherent: Submission[], ctx: ProduceCtx): boolean;
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
export function optimalBumpCountFor(absDiff: number, epsilon: number, maxBumps: number): number {
  if (epsilon <= 0 || maxBumps <= 0) return 0;
  const base = Math.floor(absDiff / epsilon);
  if (base >= maxBumps) return maxBumps;
  const baseDev = absDiff - base * epsilon;
  const nextDev = (base + 1) * epsilon - absDiff;
  return nextDev < baseDev ? Math.min(base + 1, maxBumps) : base;
}

/** Convenience: pulls ε out of ctx.inputKind for the nudge branch and
 *  delegates to `optimalBumpCountFor`. Returns 0 in quote contexts. */
export function optimalBumpCount(absDiff: number, ctx: ProduceCtx, maxBumps: number): number {
  if (ctx.inputKind.kind !== "nudge") return 0;
  return optimalBumpCountFor(absDiff, ctx.inputKind.epsilon, maxBumps);
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

  /** Set in `produceInherent` when honest picks the with-boost scenario as
   *  the closer fit to its target diff. Read back in `wantVelocityBoost`.
   *  Chain calls these two methods back-to-back on the same author, so the
   *  cross-method stash is safe. */
  private wantedBoost = false;

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
    if (ctx.inputKind.kind === "nudge") {
      return { kind: "nudge", validatorIndex: this.index, type: this.type, bump: price >= ctx.lastPrice ? Bump.Up : Bump.Down };
    }
    return { kind: "quote", validatorIndex: this.index, type: this.type, price };
  }

  produceInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    // Clear stash for this block — honest defaults to "no boost".
    this.wantedBoost = false;

    if (inputs.length === 0) return [];
    if (ctx.inputKind.kind === "quote") {
      return passThroughQuotes(inputs);
    }
    // Nudge mode: target the local price.
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const absDiff = Math.abs(diff);
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const intentDir: "up" | "down" = direction === Bump.Up ? "up" : "down";

    // Always compute the no-boost scenario.
    const baseEps = ctx.inputKind.epsilon;
    const nNoBoost = optimalBumpCountFor(absDiff, baseEps, inputs.length);
    const errNoBoost = Math.abs(absDiff - nNoBoost * baseEps);

    // Consider the with-boost scenario only if a proposal is pending AND
    // its direction matches honest's intent (M3 — the aggregator will deny
    // the boost otherwise, so opting in would be wasted).
    const vel = ctx.inputKind.velocity;
    let chosenBumps = nNoBoost;
    if (vel?.pendingProposal && vel.pendingProposal.direction === intentDir) {
      const boostedEps = vel.baseEpsilon * vel.pendingProposal.coefficient;
      const nBoost = optimalBumpCountFor(absDiff, boostedEps, inputs.length);
      const errBoost = Math.abs(absDiff - nBoost * boostedEps);
      // Tie-break: prefer no-boost (smaller error wins; equal → no boost).
      if (errBoost < errNoBoost) {
        chosenBumps = nBoost;
        this.wantedBoost = true;
      }
    }
    return pickInDirectionBumps(inputs, direction, chosenBumps);
  }

  wantVelocityBoost(_inherent: Submission[], _ctx: ProduceCtx): boolean {
    return this.wantedBoost;
  }
}

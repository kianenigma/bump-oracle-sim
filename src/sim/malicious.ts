import { Bump } from "../types.js";
import type { AggregatorMode, Submission, ValidatorParams, ValidatorPriceSource, ValidatorType } from "../types.js";
import {
  type ProduceCtx,
  type ValidatorAgent,
  optimalBumpCount,
  passThroughQuotes,
  pickInDirectionBumps,
} from "./validator.js";
import type { PriceEndpoint } from "./price-endpoint.js";

// ─────────────────────────────────────────────────────────────────────────────
// Each malicious validator extends `BaseValidator` and implements four
// mode-specific hooks:
//
//   produceQuoteInput(ctx)             — quote-mode submission (median).
//   produceNudgeInput(ctx)             — nudge-mode submission.
//   produceQuoteInherent(inputs, ctx)  — author-side selection in quote mode.
//   produceNudgeInherent(inputs, ctx)  — author-side selection in nudge mode.
//
// `BaseValidator` dispatches `ValidatorAgent` calls to the right hook based
// on `ctx.inputKind`. Adversarial knobs live on each group's `params`
// (overridable per group) with defaults in src/config.ts. Each concrete
// class also declares a `static readonly compatibleEngines` field listing
// the aggregator modes it is meaningful under; the engine consults it
// before instantiation.
// ─────────────────────────────────────────────────────────────────────────────

abstract class BaseValidator implements ValidatorAgent {
  abstract readonly type: ValidatorType;
  readonly index: number;
  readonly isHonest = false;
  protected endpoint: PriceEndpoint;
  protected rng: () => number;
  protected priceSource: ValidatorPriceSource;
  protected params: Required<ValidatorParams>;
  /** Set by velocity-aware subclasses inside `produceNudgeInherent` when
   *  they decide the boost helps their objective. Read back through the
   *  default `wantVelocityBoost` implementation below. Resets to `false`
   *  at the start of every `produceNudgeInherent` so a stale value can't
   *  leak across blocks. Subclasses that don't reason about velocity
   *  leave this at its default `false`. */
  protected wantedBoost = false;

  constructor(
    index: number,
    endpoint: PriceEndpoint,
    rng: () => number,
    priceSource: ValidatorPriceSource,
    params: Required<ValidatorParams>,
  ) {
    this.index = index;
    this.endpoint = endpoint;
    this.rng = rng;
    this.priceSource = priceSource;
    this.params = params;
  }

  /** Validator's jittered observation of real at the given block. */
  protected observe(blockIndex: number): number {
    return this.endpoint.observe(this.priceSource, blockIndex, this.rng);
  }

  // ── Mode-specific hooks ──────────────────────────────────────────────────
  // produceXxxInput may return `null` to abstain (no submission this block).
  protected abstract produceQuoteInput(ctx: ProduceCtx): Submission | null;
  protected abstract produceNudgeInput(ctx: ProduceCtx): Submission | null;
  protected abstract produceQuoteInherent(inputs: Submission[], ctx: ProduceCtx): Submission[];
  protected abstract produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[];

  // ── ValidatorAgent dispatch ──────────────────────────────────────────────

  produceInput(ctx: ProduceCtx): Submission | null {
    return ctx.inputKind.kind === "quote"
      ? this.produceQuoteInput(ctx)
      : this.produceNudgeInput(ctx);
  }

  produceInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    if (inputs.length === 0) return [];
    return ctx.inputKind.kind === "quote"
      ? this.produceQuoteInherent(inputs, ctx)
      : this.produceNudgeInherent(inputs, ctx);
  }

  /** Default `wantVelocityBoost` reads the `wantedBoost` stash. Subclasses
   *  that opt in (`malicious`, `pushy`, `pushy-max`) set `this.wantedBoost`
   *  to `true` inside their `produceNudgeInherent`. Subclasses that never
   *  reason about velocity leave it `false` — they never trigger the boost. */
  wantVelocityBoost(_inherent: Submission[], _ctx: ProduceCtx): boolean {
    return this.wantedBoost;
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

const quote = (validatorIndex: number, type: ValidatorType, price: number): Submission =>
  ({ kind: "quote", validatorIndex, type, price });

const nudge = (validatorIndex: number, type: ValidatorType, bump: Bump): Submission =>
  ({ kind: "nudge", validatorIndex, type, bump });

/** Sign of real motion this block: +1 if observed ≥ lastPrice, else -1. */
const realDirSign = (observed: number, lastPrice: number): 1 | -1 =>
  observed >= lastPrice ? 1 : -1;

/** True iff publishing `observed` would push the oracle in `direction`
 *  beyond lastPrice. The withholder family abstains on this predicate. */
const wouldPushOracle = (direction: "up" | "down", observed: number, lastPrice: number): boolean =>
  direction === "up" ? observed > lastPrice : observed < lastPrice;

/** Pick all in-direction bumps from gossip with no count cap. */
function pickAllInDirectionBumps(inputs: Submission[], direction: Bump): Submission[] {
  const out: Submission[] = [];
  for (const s of inputs) {
    if (s.kind === "nudge" && s.bump === direction) out.push(s);
  }
  return out;
}

function priceFromNudges(inputs: Submission[], eps: number, prevPrice: number): number {
  let upUps = 0;
  let upDowns = 0;
  for (const s of inputs) {
    if (s.kind !== "nudge") throw new Error("Expected nudge submissions in priceFromNudges");
    if (s.bump === Bump.Up) upUps++;
    else if (s.bump === Bump.Down) upDowns++;
  }
  return prevPrice + upUps * eps - upDowns * eps;
}

// ── MaliciousValidator ──────────────────────────────────────────────────────
// Inverse strategy. Pushes price *away* from real.
//   Nudge: emit the wrong direction; as author activate same-direction
//          (away-from-real) bumps.
//   Quote: outlier `lastPrice − dir × bias × lastPrice`. As author, keep
//          gossiped quotes whose values support the wrong side of lastPrice.
export class MaliciousValidator extends BaseValidator {
  static readonly compatibleEngines: ReadonlyArray<AggregatorMode> = ["nudge", "median"];
  readonly type: ValidatorType = "malicious";

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    const honest = this.observe(ctx.blockIndex);
    const dir = realDirSign(honest, ctx.lastPrice);
    return quote(this.index, this.type, ctx.lastPrice - dir * ctx.lastPrice * this.params.maliciousQuoteBias);
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    const honest = this.observe(ctx.blockIndex);
    return nudge(this.index, this.type, honest >= ctx.lastPrice ? Bump.Down : Bump.Up);
  }

  protected produceQuoteInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const observed = this.observe(ctx.blockIndex);
    const realDir = realDirSign(observed, ctx.lastPrice);
    // Keep quotes on the wrong side of lastPrice.
    const out: Submission[] = [];
    for (const s of inputs) {
      if (s.kind !== "quote") { throw new Error("Expected quote submissions in produceQuoteInherent"); };
      const wrongSide = realDir === 1 ? s.price < ctx.lastPrice : s.price > ctx.lastPrice;
      if (wrongSide) out.push(s);
    }
    return out;
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    if (ctx.inputKind.kind !== "nudge") throw new Error("Expected nudge submissions in produceNudgeInherent");
    this.wantedBoost = false;

    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const wrongDir = diff >= 0 ? Bump.Down : Bump.Up;
    const wrongDirStr: "up" | "down" = wrongDir === Bump.Up ? "up" : "down";
    // put all the bumps that are in the wrong direction
    const wrongBumps = inputs.filter(s => s.kind === "nudge" && s.bump === wrongDir);

    // Velocity opt-in: the boost amplifies the wrong-direction push, but
    // only when proposal direction == wrong direction. Most
    // of the time this blocks malicious because the proposal direction
    // tracks recent consensus (which moves WITH real, while malicious
    // moves AGAINST real). Opt in only when the with-boost outcome is
    // strictly more divergent than without-boost.
    const vel = ctx.inputKind.velocity;
    if (vel?.pendingProposal && vel.pendingProposal.direction === wrongDirStr) {
      const n = wrongBumps.length;
      const wrongSign = wrongDir === Bump.Up ? 1 : -1;
      const withoutPrice = ctx.lastPrice + wrongSign * n * vel.baseEpsilon;
      const withPrice = ctx.lastPrice + wrongSign * n * vel.baseEpsilon * vel.pendingProposal.coefficient;
      if (Math.abs(withPrice - targetPrice) > Math.abs(withoutPrice - targetPrice)) {
        this.wantedBoost = true;
      }
    }
    return wrongBumps;
  }
}

// ── PushyMaliciousValidator ─────────────────────────────────────────────────
// Overshoot in the honest direction.
//   Nudge: honest direction; as author activate ALL in-direction bumps.
//   Quote: outlier `real ± pushyQuoteBias × real` past real. As author keep
//          quotes that land beyond `observed` in the direction of motion.
export class PushyMaliciousValidator extends BaseValidator {
  static readonly compatibleEngines: ReadonlyArray<AggregatorMode> = ["nudge", "median"];
  readonly type: ValidatorType = "pushy";

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    const honest = this.observe(ctx.blockIndex);
    const dir = realDirSign(honest, ctx.lastPrice);
    return quote(this.index, this.type, honest + dir * this.params.pushyQuoteBias * honest);
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    const honest = this.observe(ctx.blockIndex);
    return nudge(this.index, this.type, honest >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  protected produceQuoteInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const observed = this.observe(ctx.blockIndex);
    const realDir = realDirSign(observed, ctx.lastPrice);
    // Keep quotes that overshoot past `observed` (≈ real).
    const out: Submission[] = [];
    for (const s of inputs) {
      if (s.kind !== "quote") continue;
      const overshoots = realDir === 1 ? s.price > observed : s.price < observed;
      if (overshoots) out.push(s);
    }
    return out;
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    if (ctx.inputKind.kind !== "nudge") throw new Error("Expected nudge ctx in produceNudgeInherent");
    this.wantedBoost = false;

    const targetPrice = this.observe(ctx.blockIndex);
    const direction = targetPrice >= ctx.lastPrice ? Bump.Up : Bump.Down;
    const dirStr: "up" | "down" = direction === Bump.Up ? "up" : "down";
    const bumps = pickAllInDirectionBumps(inputs, direction);

    // Velocity opt-in: the boost amplifies pushy's overshoot. Pushy pushes
    // in real's direction, which is also what `pendingProposal.direction`
    // tends to be (the proposal tracks recent consensus). So M3 typically
    // lets pushy through — this IS the tail attack the design
    // acknowledges. Opt in iff the with-boost outcome is strictly farther
    // from the observed real price.
    const vel = ctx.inputKind.velocity;
    if (vel?.pendingProposal && vel.pendingProposal.direction === dirStr) {
      const n = bumps.length;
      const sign = direction === Bump.Up ? 1 : -1;
      const withoutPrice = ctx.lastPrice + sign * n * vel.baseEpsilon;
      const withPrice = ctx.lastPrice + sign * n * vel.baseEpsilon * vel.pendingProposal.coefficient;
      if (Math.abs(withPrice - targetPrice) > Math.abs(withoutPrice - targetPrice)) {
        this.wantedBoost = true;
      }
    }
    return bumps;
  }
}

// ── MaximallyPushyNudgeValidator ────────────────────────────────────────────
// A nudge-only attacker. Instead of always maximally pushing the price in the
// "right" direction (honest), it maximally pushes the price in whichever
// direction will cause the most divergence from real.
//
// Production of nudge input remains identical to honest. Author-side: count
// the Up and Down bumps available; pick whichever yields the larger
// post-block divergence from the author's observation of real.
//
// In pUSD there is value to be extracted from EITHER direction of divergence:
//   * divergence up: over-borrow pUSD
//   * divergence down: redeem against DOTs in the vaults for cheap
// so the attack target is `max |oracle - real|`, not a fixed direction.
export class MaximallyPushyValidator extends BaseValidator {
  static readonly compatibleEngines: ReadonlyArray<AggregatorMode> = ["nudge", "median", "latched-median"];
  readonly type: ValidatorType = "pushy-max";

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    // TODO: for now our cabal is only submitting 0, but we can submit o or inf depending on which produces more divergence.
    return quote(this.index, this.type, 0);
  }

  protected produceQuoteInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const ourCabal = inputs.filter(s => s.kind === "quote" && s.type === this.type);
    if (ctx.aggregatorMode === "median") {
      // we need to meet the minInputs requirement.
      const honest = inputs.filter(s => s.kind === "quote" && s.type === "honest");
      const quotesNeeded = ctx.inputKind.kind === "quote" ? ctx.inputKind.minInputs : 0;
      const honestToInclude = Math.max(0, quotesNeeded - ourCabal.length)
      // sort all honest quotes, take the first honestToInclude, and return that.
      const sortedHonest = honest.sort((a, b) => { if (a.kind === "quote" && b.kind === "quote") { return a.price - b.price; } else { return 0; } });
      const maxBiased = sortedHonest.slice(0, honestToInclude).concat(ourCabal);
      if (maxBiased.length != quotesNeeded && quotesNeeded !== 0) {
        throw new Error(`MaximallyPushyValidator: failed to produce enough quotes: ${maxBiased.length} of ${quotesNeeded}`);
      }
      return maxBiased
    } else if (ctx.aggregatorMode === "latched-median") {
      // we can only include our own quotes in the inherent and be done.
      return ourCabal;
    } else {
      throw new Error(`MaximallyPushyValidator: unsupported aggregator mode: ${ctx.aggregatorMode}`);
    }
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    // This is basically not relevant if we are the final author as well, we will override it based
    // on the final inherent producer. For the sake of being maximally bad, we will move in the
    // wrong direction, from our perspective.
    const honest = this.observe(ctx.blockIndex);
    return nudge(this.index, this.type, honest >= ctx.lastPrice ? Bump.Down : Bump.Up);
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    if (ctx.inputKind.kind !== "nudge") throw new Error("Expected nudge submissions in produceNudgeInherent");
    this.wantedBoost = false;

    // find the cluster count of validators that are of our type.
    const ourCabal = inputs.filter(s => s.kind === "nudge" && s.type === this.type);
    const cabalAllUp = ourCabal.map(s => nudge(s.validatorIndex, s.type, Bump.Up));
    const cabalAllDown = ourCabal.map(s => nudge(s.validatorIndex, s.type, Bump.Down));

    // extract the honest cluster submissions
    const honestAllUp = inputs.filter(s => s.kind === "nudge" && s.type === "honest" && s.bump === Bump.Up);
    const honestAllDown = inputs.filter(s => s.kind === "nudge" && s.type === "honest" && s.bump === Bump.Down);

    const obs = this.observe(ctx.blockIndex);
    const baseEps = ctx.inputKind.velocity?.baseEpsilon ?? ctx.inputKind.epsilon;
    const vel = ctx.inputKind.velocity;

    // Enumerate up to 4 candidate (inherent, useBoost) configurations.
    //   1. Up direction, no boost
    //   2. Down direction, no boost
    //   3. Up direction, with boost   (only if proposal.direction === "up")
    //   4. Down direction, with boost (only if proposal.direction === "down")
    type Candidate = { inherent: Submission[]; finalPrice: number; useBoost: boolean };
    const upInherent = honestAllUp.concat(cabalAllUp);
    const downInherent = honestAllDown.concat(cabalAllDown);
    const candidates: Candidate[] = [
      { inherent: upInherent, finalPrice: priceFromNudges(upInherent, baseEps, ctx.lastPrice), useBoost: false },
      { inherent: downInherent, finalPrice: priceFromNudges(downInherent, baseEps, ctx.lastPrice), useBoost: false },
    ];
    if (vel?.pendingProposal) {
      const boostedEps = baseEps * vel.pendingProposal.coefficient;
      if (vel.pendingProposal.direction === "up") {
        candidates.push({
          inherent: upInherent,
          finalPrice: priceFromNudges(upInherent, boostedEps, ctx.lastPrice),
          useBoost: true,
        });
      } else {
        candidates.push({
          inherent: downInherent,
          finalPrice: priceFromNudges(downInherent, boostedEps, ctx.lastPrice),
          useBoost: true,
        });
      }
    }

    // Pick the candidate with the largest |finalPrice - obs|. Ties go to
    // earlier candidates (preferring no-boost on tie — conservative).
    let best = candidates[0];
    let bestDiv = Math.abs(best.finalPrice - obs);
    for (let i = 1; i < candidates.length; i++) {
      const div = Math.abs(candidates[i].finalPrice - obs);
      if (div > bestDiv) { best = candidates[i]; bestDiv = div; }
    }
    this.wantedBoost = best.useBoost;
    return best.inherent;
  }
}

// ── NoopValidator ───────────────────────────────────────────────────────────
// Author-side censorship.
//   Nudge: emit honest bumps; as author activate none → freeze.
//   Quote: abstain; as author drop the inherent → freeze.
export class NoopValidator extends BaseValidator {
  static readonly compatibleEngines: ReadonlyArray<AggregatorMode> = ["nudge", "median", "latched-median"];
  readonly type: ValidatorType = "noop";

  protected produceQuoteInput(_ctx: ProduceCtx): Submission | null {
    return null;
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    const honest = this.observe(ctx.blockIndex);
    return nudge(this.index, this.type, honest >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  protected produceQuoteInherent(_inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    return [];
  }

  protected produceNudgeInherent(_inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    return [];
  }
}

// ── DelayedValidator ────────────────────────────────────────────────────────
// Honest intent, but reads its observation from `delayBlocks` ago. Lags
// sharp moves; otherwise tracks real.
export class DelayedValidator extends BaseValidator {
  static readonly compatibleEngines: ReadonlyArray<AggregatorMode> = ["nudge", "median"];
  readonly type: ValidatorType = "delayed";

  /** Observation from `delayBlocks` ago, clamped to the start of the run. */
  private observeStale(blockIndex: number): number {
    const stale = Math.max(0, blockIndex - this.params.delayBlocks);
    return this.endpoint.observe(this.priceSource, stale, this.rng);
  }

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    return quote(this.index, this.type, this.observeStale(ctx.blockIndex));
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    const stale = this.observeStale(ctx.blockIndex);
    return nudge(this.index, this.type, stale >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  protected produceQuoteInherent(inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    return passThroughQuotes(inputs);
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const targetPrice = this.observeStale(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const needed = optimalBumpCount(Math.abs(diff), ctx, inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

// ── DriftValidator ──────────────────────────────────────────────────────────
// Persistent upward bias regardless of real price.
//   Nudge: always Up; as author activate all Up bumps.
//   Quote: lastPrice · (1 + driftQuoteStep) every block.
export class DriftValidator extends BaseValidator {
  static readonly compatibleEngines: ReadonlyArray<AggregatorMode> = ["nudge", "median"];
  readonly type: ValidatorType = "drift";

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    return quote(this.index, this.type, ctx.lastPrice * (1 + this.params.driftQuoteStep));
  }

  protected produceNudgeInput(_ctx: ProduceCtx): Submission {
    return nudge(this.index, this.type, Bump.Up);
  }

  protected produceQuoteInherent(inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    return passThroughQuotes(inputs);
  }

  protected produceNudgeInherent(inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    return pickAllInDirectionBumps(inputs, Bump.Up);
  }
}

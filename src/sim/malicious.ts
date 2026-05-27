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
    const eps = ctx.inputKind.epsilon;
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Down : Bump.Up; // wrong direction
    // put all the bumps that are in the wrong direction
    return inputs.filter(s => s.kind === "nudge" && s.bump === direction);
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
    const targetPrice = this.observe(ctx.blockIndex);
    const direction = targetPrice >= ctx.lastPrice ? Bump.Up : Bump.Down;
    return pickAllInDirectionBumps(inputs, direction);
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
export class MaximallyPushyNudgeValidator extends BaseValidator {
  static readonly compatibleEngines: ReadonlyArray<AggregatorMode> = ["nudge"];
  readonly type: ValidatorType = "pushy-max";

  protected produceQuoteInput(_ctx: ProduceCtx): Submission {
    throw new Error(
      `MaximallyPushyNudgeValidator (index=${this.index}): quote-mode is unsupported. ` +
      `Use --aggregator=nudge.`,
    );
  }

  protected produceQuoteInherent(_inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    throw new Error(
      `MaximallyPushyNudgeValidator (index=${this.index}): quote-mode is unsupported. ` +
      `Use --aggregator=nudge.`,
    );
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
    const eps = ctx.inputKind.epsilon;

    // find the cluster count of validators that are of our type.
    const ourCabal = inputs.filter(s => s.kind === "nudge" && s.type === this.type);
    const cabalAllUp = ourCabal.map(s => nudge(s.validatorIndex, s.type, Bump.Up));
    const cabalAllDown = ourCabal.map(s => nudge(s.validatorIndex, s.type, Bump.Down));

    // extract the honest cluster submissions
    const honestAllUp = inputs.filter(s => s.kind === "nudge" && s.type === "honest" && s.bump === Bump.Up);
    const honestAllDown = inputs.filter(s => s.kind === "nudge" && s.type === "honest" && s.bump === Bump.Down);

    // Calculate final price, if our entire cluster changes to Up, combined with honest cluster.
    const upFinal = priceFromNudges(honestAllUp.concat(cabalAllUp), eps, ctx.lastPrice);
    const downFinal = priceFromNudges(honestAllDown.concat(cabalAllDown), eps, ctx.lastPrice);

    // See which one produces more deviation from the real price.
    const obs = this.observe(ctx.blockIndex);
    const upDiv = Math.abs(upFinal - obs);
    const downDiv = Math.abs(downFinal - obs);

    if (upDiv >= downDiv) {
      return honestAllUp.concat(cabalAllUp);
    } else {
      return honestAllDown.concat(cabalAllDown);
    }
  }
}

// ── NoopValidator ───────────────────────────────────────────────────────────
// Author-side censorship.
//   Nudge: emit honest bumps; as author activate none → freeze.
//   Quote: abstain; as author drop the inherent → freeze.
export class NoopValidator extends BaseValidator {
  static readonly compatibleEngines: ReadonlyArray<AggregatorMode> = ["nudge", "median"];
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

// ── WithholderValidator ─────────────────────────────────────────────────────
// 1/3-cabal that abstains exactly when honest publication would push the
// oracle in `withholderDirection`. The chain moves only AGAINST the attack
// direction: the oracle ratchets one way over any period in which real
// drifts in the suppressed direction. Implicit coordination via shared
// observable.
//
// Nudge-only — quote-mode hooks throw because this validator is only
// meaningful against the nudge aggregator's bump pool.
export class WithholderValidator extends BaseValidator {
  static readonly compatibleEngines: ReadonlyArray<AggregatorMode> = ["nudge"];
  readonly type: ValidatorType = "withholder";

  private suppressing(observed: number, lastPrice: number): boolean {
    return wouldPushOracle(this.params.withholderDirection, observed, lastPrice);
  }

  protected produceQuoteInput(_ctx: ProduceCtx): Submission {
    throw new Error(
      `WithholderValidator (index=${this.index}): quote-mode is unsupported. ` +
      `Use --aggregator=nudge.`,
    );
  }

  protected produceQuoteInherent(_inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    throw new Error(
      `WithholderValidator (index=${this.index}): quote-mode is unsupported. ` +
      `Use --aggregator=nudge.`,
    );
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission | null {
    const observed = this.observe(ctx.blockIndex);
    if (this.suppressing(observed, ctx.lastPrice)) return null;
    return nudge(this.index, this.type, observed >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const observed = this.observe(ctx.blockIndex);
    if (this.suppressing(observed, ctx.lastPrice)) return [];
    const diff = observed - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const needed = optimalBumpCount(Math.abs(diff), ctx, inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

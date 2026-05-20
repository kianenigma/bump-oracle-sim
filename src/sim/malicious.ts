import { Bump } from "../types.js";
import type { Submission, ValidatorParams, ValidatorPriceSource, ValidatorType } from "../types.js";
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
//   produceQuoteInput(ctx)             — quote-mode submission (median, mean).
//   produceNudgeInput(ctx)             — nudge-mode submission.
//   produceQuoteInherent(inputs, ctx)  — author-side selection in quote mode.
//   produceNudgeInherent(inputs, ctx)  — author-side selection in nudge mode.
//
// `BaseValidator` dispatches `ValidatorAgent` calls to the right hook based
// on `ctx.inputKind`. Adversarial knobs live on each group's `params`
// (overridable per group) with defaults in src/config.ts.
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
  protected abstract produceQuoteInput(ctx: ProduceCtx): Submission;
  protected abstract produceNudgeInput(ctx: ProduceCtx): Submission;
  protected abstract produceQuoteInherent(inputs: Submission[], ctx: ProduceCtx): Submission[];
  protected abstract produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[];

  // ── ValidatorAgent dispatch ──────────────────────────────────────────────

  produceInput(ctx: ProduceCtx): Submission {
    // Both "nudge" and "nudge-adaptive" want bump submissions; same hook.
    return ctx.inputKind === "quote"
      ? this.produceQuoteInput(ctx)
      : this.produceNudgeInput(ctx);
  }

  produceInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    if (inputs.length === 0) return [];
    return ctx.inputKind === "quote"
      ? this.produceQuoteInherent(inputs, ctx)
      : this.produceNudgeInherent(inputs, ctx);
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

const abstain = (validatorIndex: number): Submission =>
  ({ kind: "abstain", validatorIndex });

const quote = (validatorIndex: number, price: number): Submission =>
  ({ kind: "quote", validatorIndex, price });

const nudge = (validatorIndex: number, bump: Bump): Submission =>
  ({ kind: "nudge", validatorIndex, bump });

const bumpFor = (direction: "up" | "down"): Bump =>
  direction === "up" ? Bump.Up : Bump.Down;

const signFor = (direction: "up" | "down"): 1 | -1 =>
  direction === "up" ? 1 : -1;

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

/** Estimate cumulative oracle overshoot in units of ε relative to a
 *  validator's own observation. Positive iff oracle has drifted past
 *  observed-real in the bias direction. */
function overshootInBumps(observed: number, lastPrice: number, biasSign: 1 | -1, epsilon: number): number {
  if (epsilon <= 0) return 0;
  return ((lastPrice - observed) * biasSign) / epsilon;
}

// ── MaliciousValidator ──────────────────────────────────────────────────────
// Inverse strategy. Pushes price *away* from real.
//   Nudge: emit the wrong direction; as author activate same-direction
//          (away-from-real) bumps.
//   Quote: outlier `lastPrice − dir × bias × lastPrice`. As author, keep
//          gossiped quotes whose values support the wrong side of lastPrice.
export class MaliciousValidator extends BaseValidator {
  readonly type: ValidatorType = "malicious";

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    const honest = this.observe(ctx.blockIndex);
    const dir = realDirSign(honest, ctx.lastPrice);
    return quote(this.index, ctx.lastPrice - dir * ctx.lastPrice * this.params.maliciousQuoteBias);
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    const honest = this.observe(ctx.blockIndex);
    return nudge(this.index, honest >= ctx.lastPrice ? Bump.Down : Bump.Up);
  }

  protected produceQuoteInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const observed = this.observe(ctx.blockIndex);
    const realDir = realDirSign(observed, ctx.lastPrice);
    // Keep quotes on the wrong side of lastPrice.
    const out: Submission[] = [];
    for (const s of inputs) {
      if (s.kind !== "quote") continue;
      const wrongSide = realDir === 1 ? s.price < ctx.lastPrice : s.price > ctx.lastPrice;
      if (wrongSide) out.push(s);
    }
    return out;
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Down : Bump.Up; // wrong direction
    const needed = Math.min(Math.round(Math.abs(diff) / ctx.epsilon), inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

// ── PushyMaliciousValidator ─────────────────────────────────────────────────
// Overshoot in the honest direction.
//   Nudge: honest direction; as author activate ALL in-direction bumps.
//   Quote: outlier `real ± pushyQuoteBias × real` past real. As author keep
//          quotes that land beyond `observed` in the direction of motion.
export class PushyMaliciousValidator extends BaseValidator {
  readonly type: ValidatorType = "pushy";

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    const honest = this.observe(ctx.blockIndex);
    const dir = realDirSign(honest, ctx.lastPrice);
    return quote(this.index, honest + dir * this.params.pushyQuoteBias * honest);
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    const honest = this.observe(ctx.blockIndex);
    return nudge(this.index, honest >= ctx.lastPrice ? Bump.Up : Bump.Down);
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


/// A pushy validator that works on the nudge model and instead of always maximally pushing the price in the right direction, it simply maximally pushes the price in any direction that will cause the msot divergence from the real price.
/// Production of nudge remains same as the honest.
/// It is fully incompatible with quote mode, for now the produceQoute functions return a runtime error.
///
/// This is a valid attack because in pUSD there is value to be extracted both if the price is pushed up or down. All that matters for you, as an attacker cabal that control x% of the validators with this behavior, to casue the maximum difference from the real price:
/// * divergence up: you can over-borrow pUSD (not super profitable, but okay)
/// * Divergence down: you have a direct way to profit from the system by redeeming against DOTs in the vaults for cheap.
export class MaximallyPushyNudgeValidator extends BaseValidator {
  readonly type: ValidatorType = "pushy-max";

  protected produceQuoteInput(_ctx: ProduceCtx): Submission {
    throw new Error(
      `MaximallyPushyNudgeValidator (index=${this.index}): quote-mode is unsupported. ` +
      `Use --aggregator=nudge or --aggregator=nudge-adaptive.`,
    );
  }

  protected produceQuoteInherent(_inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    throw new Error(
      `MaximallyPushyNudgeValidator (index=${this.index}): quote-mode is unsupported. ` +
      `Use --aggregator=nudge or --aggregator=nudge-adaptive.`,
    );
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    const honest = this.observe(ctx.blockIndex);
    return nudge(this.index, honest >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  // Author-side: count the Up and Down bumps available in gossip; simulate
  // both "activate all Up" and "activate all Down"; pick whichever yields the
  // larger post-block divergence from the author's observation of real.
  //
  // This is strictly stronger than the existing `malicious` attacker (which
  // always pushes away-from-real). When the honest-direction overshoot would
  // travel further past real than the wrong-direction extreme, this attacker
  // takes it; otherwise it falls back to the wrong-direction push. Ties go
  // to UP arbitrarily (consistent, RNG-free).
  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    let upCount = 0, downCount = 0;
    for (const s of inputs) {
      if (s.kind !== "nudge") continue;
      if (s.bump === Bump.Up) upCount++;
      else if (s.bump === Bump.Down) downCount++;
    }

    // Predict the post-block price for each candidate net signed sum,
    // mirroring the aggregator's update rule so the choice is exact rather
    // than approximate. Adaptive aggregator's quadratic damping is handled
    // here too — full consensus moves further than partial.
    const priceForNet = (net: number): number => {
      if (ctx.inputKind === "nudge-adaptive") {
        const V = ctx.validatorCount;
        const agreement = V > 0 ? Math.abs(net) / V : 0;
        return ctx.lastPrice + ctx.epsilon * net * agreement;
      }
      return ctx.lastPrice + net * ctx.epsilon;
    };

    const obs = this.observe(ctx.blockIndex);
    const upDiv   = Math.abs(priceForNet(+upCount)   - obs);
    const downDiv = Math.abs(priceForNet(-downCount) - obs);
    const direction = upDiv >= downDiv ? Bump.Up : Bump.Down;
    return pickAllInDirectionBumps(inputs, direction);
  }
}

// ── NoopValidator ───────────────────────────────────────────────────────────
// Author-side censorship.
//   Nudge: emit honest bumps; as author activate none → freeze.
//   Quote: abstain; as author drop the inherent → freeze.
export class NoopValidator extends BaseValidator {
  readonly type: ValidatorType = "noop";

  protected produceQuoteInput(_ctx: ProduceCtx): Submission {
    return abstain(this.index);
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    const honest = this.observe(ctx.blockIndex);
    return nudge(this.index, honest >= ctx.lastPrice ? Bump.Up : Bump.Down);
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
  readonly type: ValidatorType = "delayed";

  /** Observation from `delayBlocks` ago, clamped to the start of the run. */
  private observeStale(blockIndex: number): number {
    const stale = Math.max(0, blockIndex - this.params.delayBlocks);
    return this.endpoint.observe(this.priceSource, stale, this.rng);
  }

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    return quote(this.index, this.observeStale(ctx.blockIndex));
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    const stale = this.observeStale(ctx.blockIndex);
    return nudge(this.index, stale >= ctx.lastPrice ? Bump.Up : Bump.Down);
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
  readonly type: ValidatorType = "drift";

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    return quote(this.index, ctx.lastPrice * (1 + this.params.driftQuoteStep));
  }

  protected produceNudgeInput(_ctx: ProduceCtx): Submission {
    return nudge(this.index, Bump.Up);
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
// oracle in `withholderDirection`. At 1/3 saturation simultaneous abstention
// drops the inherent quote count below the median's `2N/3 + 1` minInputs gate
// → freeze. The chain therefore moves only AGAINST the attack direction:
// the oracle ratchets one way over any period in which real drifts in the
// suppressed direction. Implicit coordination via shared observable.
export class WithholderValidator extends BaseValidator {
  readonly type: ValidatorType = "withholder";

  private suppressing(observed: number, lastPrice: number): boolean {
    return wouldPushOracle(this.params.withholderDirection, observed, lastPrice);
  }

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    const observed = this.observe(ctx.blockIndex);
    return this.suppressing(observed, ctx.lastPrice)
      ? abstain(this.index)
      : quote(this.index, observed);
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    // Same shape as quote-mode: abstain on against-bias observations.
    // Nudge minInputs = 0 by default so this can't trip a freeze, but
    // we abstain anyway for uniformity across modes.
    const observed = this.observe(ctx.blockIndex);
    if (this.suppressing(observed, ctx.lastPrice)) return abstain(this.index);
    return nudge(this.index, observed >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  protected produceQuoteInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const observed = this.observe(ctx.blockIndex);
    if (this.suppressing(observed, ctx.lastPrice)) return [];
    return passThroughQuotes(inputs);
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

// ── BiasInjectorValidator ───────────────────────────────────────────────────
// Two legs:
//   Quote: identical to Withholder. Abstain on against-bias observations.
//   Nudge: pool-poison + asymmetric author. Every member always emits a
//          bias-direction bump (regardless of observation), so the gossip
//          pool always carries 100 same-direction bumps. As cabal author,
//          on with-bias real motion activate ALL in-direction bumps
//          (max overshoot); on against-bias real motion return [] (skip
//          honest correction by freezing the chain).
export class BiasInjectorValidator extends BaseValidator {
  readonly type: ValidatorType = "bias-injector";

  private get biasBump(): Bump { return bumpFor(this.params.biasInjectorDirection); }

  private suppressing(observed: number, lastPrice: number): boolean {
    return wouldPushOracle(this.params.biasInjectorDirection, observed, lastPrice);
  }

  /** Real motion this block agrees with the bias direction. */
  private realMovesWithBias(observed: number, lastPrice: number): boolean {
    return this.params.biasInjectorDirection === "up"
      ? observed >= lastPrice
      : observed <= lastPrice;
  }

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    const observed = this.observe(ctx.blockIndex);
    return this.suppressing(observed, ctx.lastPrice)
      ? abstain(this.index)
      : quote(this.index, observed);
  }

  /** Pool-poison: bias-direction bump every block, no observation needed. */
  protected produceNudgeInput(_ctx: ProduceCtx): Submission {
    return nudge(this.index, this.biasBump);
  }

  protected produceQuoteInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const observed = this.observe(ctx.blockIndex);
    if (this.suppressing(observed, ctx.lastPrice)) return [];
    return passThroughQuotes(inputs);
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const observed = this.observe(ctx.blockIndex);
    if (!this.realMovesWithBias(observed, ctx.lastPrice)) {
      // Selective freeze: skip correction blocks.
      return [];
    }
    return pickAllInDirectionBumps(inputs, this.biasBump);
  }
}

// ── OvershootRatchetValidator ───────────────────────────────────────────────
// Pool-poison every block and, as author, inject ALL in-direction bumps on
// every cabal-authored block (with-bias OR against-bias real motion) until
// cumulative overshoot exceeds `overshootRatchetCeilingBumps`. Past the
// ceiling, freeze to lock in gains. Quote leg: identical to Withholder.
export class OvershootRatchetValidator extends BaseValidator {
  readonly type: ValidatorType = "overshoot-ratchet";

  private get biasBump(): Bump { return bumpFor(this.params.overshootRatchetDirection); }
  private get biasSign(): 1 | -1 { return signFor(this.params.overshootRatchetDirection); }

  private suppressing(observed: number, lastPrice: number): boolean {
    return wouldPushOracle(this.params.overshootRatchetDirection, observed, lastPrice);
  }

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    const observed = this.observe(ctx.blockIndex);
    return this.suppressing(observed, ctx.lastPrice)
      ? abstain(this.index)
      : quote(this.index, observed);
  }

  protected produceNudgeInput(_ctx: ProduceCtx): Submission {
    return nudge(this.index, this.biasBump);
  }

  protected produceQuoteInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const observed = this.observe(ctx.blockIndex);
    if (this.suppressing(observed, ctx.lastPrice)) return [];
    return passThroughQuotes(inputs);
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const observed = this.observe(ctx.blockIndex);
    const overshoot = overshootInBumps(observed, ctx.lastPrice, this.biasSign, ctx.epsilon);
    if (overshoot >= this.params.overshootRatchetCeilingBumps) {
      return [];
    }
    return pickAllInDirectionBumps(inputs, this.biasBump);
  }
}

// ── StealthWithholderValidator ──────────────────────────────────────────────
// Withholder variant with zero-jitter cross-venue observation, so all cabal
// members see the IDENTICAL real price and abstain in lock-step. Every
// abstain block becomes a freeze block. Used to bypass per-validator
// confidence callbacks that only fire on non-freeze blocks. Nudge leg
// identical to OvershootRatchet.
//
// The abstain threshold (`stealthAbstainThreshold`) is the minimum
// fractional move beyond lastPrice that triggers suppression, so the cabal
// only spends abstention on blocks where the chain would meaningfully move.
export class StealthWithholderValidator extends BaseValidator {
  readonly type: ValidatorType = "stealth-withholder";

  private get biasBump(): Bump { return bumpFor(this.params.stealthWithholderDirection); }
  private get biasSign(): 1 | -1 { return signFor(this.params.stealthWithholderDirection); }

  private suppressing(observed: number, lastPrice: number): boolean {
    const t = this.params.stealthAbstainThreshold;
    return this.params.stealthWithholderDirection === "up"
      ? observed > lastPrice * (1 + t)
      : observed < lastPrice * (1 - t);
  }

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    const observed = this.observe(ctx.blockIndex);
    return this.suppressing(observed, ctx.lastPrice)
      ? abstain(this.index)
      : quote(this.index, observed);
  }

  protected produceNudgeInput(_ctx: ProduceCtx): Submission {
    return nudge(this.index, this.biasBump);
  }

  protected produceQuoteInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const observed = this.observe(ctx.blockIndex);
    if (this.suppressing(observed, ctx.lastPrice)) return [];
    return passThroughQuotes(inputs);
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const observed = this.observe(ctx.blockIndex);
    const overshoot = overshootInBumps(observed, ctx.lastPrice, this.biasSign, ctx.epsilon);
    if (overshoot >= this.params.overshootRatchetCeilingBumps) {
      return [];
    }
    return pickAllInDirectionBumps(inputs, this.biasBump);
  }
}

// ── ConvergentCabalValidator ────────────────────────────────────────────────
// Trend-gated lockstep abstention. Each cabal member maintains a rolling
// buffer of recent observations and only abstains when (a) the local
// observation pushes oracle in the bias direction AND (b) real has moved
// `convergentCabalTrendMagnitude` in that direction over the
// `convergentCabalTrendBlocks`-block window. Buffers stay byte-identical
// across the cabal as long as observations are zero-jitter cross-venue.
//
// On non-trend blocks the cabal submits in-band honest quotes — earning
// reward in any confidence-tracking defense. By gating abstain on a sustained
// trend the cabal trades raw freeze frequency for staying alive indefinitely
// (reward arbitrage against per-block absent penalty).
//
// Nudge leg: pool-poison + ceiling-clamped author ratchet.
export class ConvergentCabalValidator extends BaseValidator {
  readonly type: ValidatorType = "convergent-cabal";

  /** Per-member rolling buffer; with zero-jitter observations all cabal
   *  buffers are byte-identical → implicit coordination. */
  private trendBuf: number[] = [];

  private get biasBump(): Bump { return bumpFor(this.params.convergentCabalDirection); }
  private get biasSign(): 1 | -1 { return signFor(this.params.convergentCabalDirection); }

  private recordObservation(observed: number): void {
    const n = this.params.convergentCabalTrendBlocks;
    this.trendBuf.push(observed);
    if (this.trendBuf.length > n) this.trendBuf.shift();
  }

  private trendInBiasDirection(): boolean {
    const n = this.params.convergentCabalTrendBlocks;
    if (this.trendBuf.length < n) return false;
    const first = this.trendBuf[0];
    const last = this.trendBuf[this.trendBuf.length - 1];
    if (first <= 0) return false;
    const move = (last - first) / first;
    const threshold = this.params.convergentCabalTrendMagnitude;
    return this.biasSign === 1 ? move >= threshold : move <= -threshold;
  }

  private suppressing(observed: number, lastPrice: number): boolean {
    if (!wouldPushOracle(this.params.convergentCabalDirection, observed, lastPrice)) return false;
    return this.trendInBiasDirection();
  }

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    const observed = this.observe(ctx.blockIndex);
    this.recordObservation(observed);
    return this.suppressing(observed, ctx.lastPrice)
      ? abstain(this.index)
      : quote(this.index, observed);
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    // Keep the trend buffer fresh under either input mode.
    this.recordObservation(this.observe(ctx.blockIndex));
    return nudge(this.index, this.biasBump);
  }

  protected produceQuoteInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const observed = this.observe(ctx.blockIndex);
    if (this.suppressing(observed, ctx.lastPrice)) return [];
    return passThroughQuotes(inputs);
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const observed = this.observe(ctx.blockIndex);
    const overshoot = overshootInBumps(observed, ctx.lastPrice, this.biasSign, ctx.epsilon);
    if (overshoot >= this.params.convergentCabalCeilingBumps) {
      return [];
    }
    return pickAllInDirectionBumps(inputs, this.biasBump);
  }
}

// ── InBandShifterValidator ──────────────────────────────────────────────────
// Submit `lastPrice * (1 ± inbandShifterQuoteBias)` every block — strictly
// inside any reasonable goodBand. The cabal NEVER abstains and NEVER submits
// out-of-band, so per-validator confidence policies that key off
// abstention or bad-quote distance never fire against the cabal directly.
// Whatever attack power exists is bounded by the median's intrinsic
// outlier-robustness. Nudge leg: pool-poison + ceiling-clamped overshoot.
export class InBandShifterValidator extends BaseValidator {
  readonly type: ValidatorType = "inband-shifter";

  private get biasBump(): Bump { return bumpFor(this.params.inbandShifterDirection); }
  private get biasSign(): 1 | -1 { return signFor(this.params.inbandShifterDirection); }

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    return quote(this.index, ctx.lastPrice * (1 + this.biasSign * this.params.inbandShifterQuoteBias));
  }

  protected produceNudgeInput(_ctx: ProduceCtx): Submission {
    return nudge(this.index, this.biasBump);
  }

  protected produceQuoteInherent(inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    return passThroughQuotes(inputs);
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    const observed = this.observe(ctx.blockIndex);
    const overshoot = overshootInBumps(observed, ctx.lastPrice, this.biasSign, ctx.epsilon);
    if (overshoot >= this.params.inbandShifterCeilingBumps) {
      return [];
    }
    return pickAllInDirectionBumps(inputs, this.biasBump);
  }
}

// ── BoundaryClusterValidator ────────────────────────────────────────────────
// Median-targeted attacker. The cabal tightly clusters its quotes at a value
// just inside the honest distribution — `lastPrice * (1 ± boundaryClusterBias)`
// — picked small enough that the cluster lands between the honest lower
// quartile and the honest median. With a sizable cabal (e.g. 33%) all voting
// the SAME value, the median's rank position is dragged into the cluster,
// pulling the aggregated price toward `lastPrice * (1 ± bias)` rather than
// real. No author-side games (pure pass-through quotes); nudge-mode behaves
// identically to honest so the attacker is well-defined cross-aggregator
// while only being effective against median.
export class BoundaryClusterValidator extends BaseValidator {
  readonly type: ValidatorType = "boundary-cluster";

  private get biasSign(): 1 | -1 { return signFor(this.params.boundaryClusterDirection); }

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    return quote(this.index, ctx.lastPrice * (1 + this.biasSign * this.params.boundaryClusterBias));
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    // Mimic honest nudge submission.
    const price = this.observe(ctx.blockIndex);
    return nudge(this.index, price >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  protected produceQuoteInherent(inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    return passThroughQuotes(inputs);
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    // Mimic honest nudge author selection.
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const needed = optimalBumpCount(Math.abs(diff), ctx, inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

// ── AuthorCensorValidator ───────────────────────────────────────────────────
// Median-targeted author-side censorship cabal. Cabal members submit honest
// quotes (so they look like normal voters when not authoring). The attack
// fires only when a cabal member is the block author: they compute a pivot
// `lastPrice * (1 + sign * authorCensorBias)` and DROP every gossiped quote
// on the wrong side of pivot. With a sizable cabal, ~1/N blocks of the time
// the inherent is heavily skewed in `authorCensorDirection`, dragging the
// median toward the cabal's biased value rather than real. Nudge leg mirrors
// honest behaviour so the validator is well-defined cross-aggregator.
export class AuthorCensorValidator extends BaseValidator {
  readonly type: ValidatorType = "author-censor";

  private get biasSign(): 1 | -1 { return signFor(this.params.authorCensorDirection); }

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    // Submit the honest observation — attack is purely author-side.
    return quote(this.index, this.observe(ctx.blockIndex));
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    // Mimic honest nudge submission.
    const price = this.observe(ctx.blockIndex);
    return nudge(this.index, price >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  protected produceQuoteInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    // Drop every quote on the wrong side of the pivot. For "down" (sign=-1)
    // the pivot lies below lastPrice and we keep only quotes ≤ pivot, so the
    // remaining inherent's median lands well below lastPrice.
    const pivot = ctx.lastPrice * (1 + this.biasSign * this.params.authorCensorBias);
    const out: Submission[] = [];
    for (const s of inputs) {
      if (s.kind !== "quote") continue;
      const keep = this.biasSign === -1 ? s.price <= pivot : s.price >= pivot;
      if (keep) out.push(s);
    }
    return out;
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    // Mimic honest nudge author selection.
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const needed = optimalBumpCount(Math.abs(diff), ctx, inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

// ── StateAwareSandwichValidator ─────────────────────────────────────────────
// State-aware "follow the wrong way" attack. The cabal observes whether the
// oracle is currently trailing or leading real (relative to its own jittered
// observation) and submits a quote that pushes the oracle FURTHER from real
// in whichever direction the error already sits — turning a transient
// per-block tracking gap into a persistent multi-block divergence the median
// cleanly tracks (since the cabal sits ~33% and the bias is tuned to land in
// the sorted middle).
//   Quote: if observed > lastPrice (oracle trails real-up), submit
//          lastPrice·(1 - sandwichBias) — push oracle further DOWN.
//          if observed < lastPrice (oracle leads real-down), submit
//          lastPrice·(1 + sandwichBias) — push oracle further UP.
//          As author: pure pass-through (no author games).
//   Nudge: act exactly like HonestValidator (attack only bites under median).
export class StateAwareSandwichValidator extends BaseValidator {
  readonly type: ValidatorType = "state-aware-sandwich";

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    const obs = this.observe(ctx.blockIndex);
    // observed > lastPrice → oracle trails real → push DOWN (away from real)
    // observed < lastPrice → oracle leads real  → push UP   (away from real)
    const sign: 1 | -1 = obs > ctx.lastPrice ? -1 : 1;
    return quote(this.index, ctx.lastPrice * (1 + sign * this.params.sandwichBias));
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    // Honest nudge mimicry — attack only bites under median.
    const price = this.observe(ctx.blockIndex);
    return nudge(this.index, price >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  protected produceQuoteInherent(inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    return passThroughQuotes(inputs);
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    // Honest nudge author selection.
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const needed = optimalBumpCount(Math.abs(diff), ctx, inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

// ── MedianWalkingCabalValidator ─────────────────────────────────────────────
// Round-4 median-targeted cabal. Goes beyond `author-censor` by not just
// dropping quotes but actively *manufacturing* an inherent that consists
// solely of the cabal's own tightly-clustered low quotes. The cabal-author
// inherent is therefore a degenerate distribution where median == cabal target.
//
//   Quote: every cabal member submits the SAME outlier price
//          `lastPrice * (1 - medianWalkBias)` (default 50% — extreme low),
//          forming a tight cluster far below any honest quote (which sits
//          near `lastPrice`). Cluster identifiability: any quote with
//          price < lastPrice * 0.6 is a cabal quote.
//   Quote-mode author: filter the gossiped inputs to keep ONLY cabal quotes
//          (price < lastPrice * 0.6). With ~1/3 cabal share, ~N/3 quotes
//          remain — well below the median's `floor(2N/3) + 1` minInputs gate,
//          so the aggregator either freezes (lastPrice held) or, if minInputs
//          isn't enforced, computes median over the cabal cluster → catastrophic
//          drop. Either outcome is bad for median.
//   Nudge: act exactly like HonestValidator — attack only bites under median.
export class MedianWalkingCabalValidator extends BaseValidator {
  readonly type: ValidatorType = "median-walking-cabal";

  /** Cabal cluster identifier: quotes far below lastPrice are cabal quotes. */
  private isCabalQuote(price: number, lastPrice: number): boolean {
    // medianWalkBias = 0.5 puts cabal at lastPrice * 0.5; threshold 0.6
    // sits comfortably between honest (≈lastPrice) and cabal cluster.
    return price < lastPrice * 0.6;
  }

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    return quote(this.index, ctx.lastPrice * (1 - this.params.medianWalkBias));
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    // Honest nudge mimicry — attack only bites under median.
    const price = this.observe(ctx.blockIndex);
    return nudge(this.index, price >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  protected produceQuoteInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    // Keep ONLY cabal quotes (the tight low cluster). With ~1/3 cabal share
    // the surviving inherent is well below median's minInputs gate → the
    // chain freezes; if a deployment skips minInputs, median collapses to
    // the cabal target instead. Both outcomes wreck median's tracking.
    const out: Submission[] = [];
    for (const s of inputs) {
      if (s.kind !== "quote") continue;
      if (this.isCabalQuote(s.price, ctx.lastPrice)) out.push(s);
    }
    return out;
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    // Honest nudge author selection.
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const needed = optimalBumpCount(Math.abs(diff), ctx, inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

// ── TrimEdgeValidator ───────────────────────────────────────────────────────
// Coordinated cluster + author-side trim attack. All cabal members submit a
// deterministic biased quote `lastPrice * (1 ± trimEdgeBias)` (default 10%
// below). Honest jitter (~0.1%) is far smaller than the cabal bias, so the
// cabal cluster sits clearly outside the honest distribution.
//
// As author, the cabal sorts gossiped quotes ascending by price and drops
// exactly `floor(N/3)` quotes from the OPPOSITE end of the cabal cluster:
//   direction="down": cabal at the bottom — drop the top floor(N/3).
//   direction="up"  : cabal at the top    — drop the bottom floor(N/3).
//
// With N=100 and ~33 cabal, this leaves ~67 quotes (matching the floor(2N/3)+1
// minInputs gate exactly) consisting of cabal cluster + the half of honest
// quotes nearest the cabal. The median of that surviving set lands at the
// boundary between the cabal cluster and the inner honest tail — a substantial
// shift each cabal-author block, **without freezing the chain**.
//
// Nudge mode: identical to HonestValidator (the attack only bites under median).
export class TrimEdgeValidator extends BaseValidator {
  readonly type: ValidatorType = "trim-edge";

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    const sign = signFor(this.params.trimEdgeDirection);
    return quote(this.index, ctx.lastPrice * (1 + sign * this.params.trimEdgeBias));
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    // Mirror HonestValidator nudge-mode behaviour exactly.
    const observed = this.observe(ctx.blockIndex);
    return nudge(this.index, observed >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  protected produceQuoteInherent(inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    // Filter to quote-kind only (drop bumps/abstains), then sort ascending.
    const quotes: Submission[] = [];
    for (const s of inputs) if (s.kind === "quote") quotes.push(s);
    quotes.sort((a, b) => {
      const pa = (a as { kind: "quote"; price: number }).price;
      const pb = (b as { kind: "quote"; price: number }).price;
      return pa - pb;
    });
    const dropCount = Math.floor(quotes.length / 3);
    if (dropCount <= 0) return quotes;
    if (this.params.trimEdgeDirection === "down") {
      // Cabal at the bottom — drop the top `dropCount` (highest values).
      return quotes.slice(0, quotes.length - dropCount);
    } else {
      // Cabal at the top — drop the bottom `dropCount` (lowest values).
      return quotes.slice(dropCount);
    }
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    // Mirror HonestValidator nudge-mode author selection exactly.
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const needed = optimalBumpCount(Math.abs(diff), ctx, inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

// ── InnerClusterShifterValidator ────────────────────────────────────────────
// Pure quote-poisoning: cabal members all submit
// `obs * (1 - innerClusterBias)` — a value that lands INSIDE the honest
// distribution (cluster sits ~0.8σ below real on synthetic data with σ≈0.1%).
// At ~33% saturation, the cabal cluster is dense enough to occupy median rank
// 50, dragging the median down by `innerClusterBias` per block. Crucially:
//   - No abstention (inherent quota always satisfied → minInputs gate intact)
//   - No author manipulation (pass-through quotes — looks identical to honest
//     when authoring; per-validator audit shows in-band, near-real quotes)
//   - Bias is small enough (~0.08%) that each cabal quote lies strictly within
//     the honest spread, evading any "outlier" or wideband distance defense
// Nudge mode mirrors HonestValidator exactly so the validator is well-defined
// cross-aggregator while only biting under median.
export class InnerClusterShifterValidator extends BaseValidator {
  readonly type: ValidatorType = "inner-cluster-shifter";

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    // Use own jittered observation (tracks real, not the potentially-skewed
    // oracle lastPrice). Submit a value just inside the lower edge of the
    // honest cluster so the cabal sorts into the median rank region.
    const obs = this.observe(ctx.blockIndex);
    return quote(this.index, obs * (1 - this.params.innerClusterBias));
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    // Mirror HonestValidator nudge-mode behaviour exactly.
    const price = this.observe(ctx.blockIndex);
    return nudge(this.index, price >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  protected produceQuoteInherent(inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    // Pure pass-through — no author-side games.
    return passThroughQuotes(inputs);
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    // Mirror HonestValidator nudge-mode author selection exactly.
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const needed = optimalBumpCount(Math.abs(diff), ctx, inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

// ── AsymmetricTrimChaserValidator ───────────────────────────────────────────
// Round-7 attack vector. State-aware variant of TrimEdge that adaptively flips
// both the cabal cluster side AND the author-side trim side based on which
// direction will push the oracle FURTHER from real this block:
//
//   obs > lastPrice  → oracle is BELOW real → push it further DOWN.
//                       currentDir = -1, cluster at lastPrice*(1-bias),
//                       author drops the TOP floor(N/3) quotes.
//   obs < lastPrice  → oracle is ABOVE real → push it further UP.
//                       currentDir = +1, cluster at lastPrice*(1+bias),
//                       author drops the BOTTOM floor(N/3) quotes.
//
// Every cabal member observes the same real price (intended jitter≈0 within
// group) and updates `currentDir` in lock-step inside produceQuoteInput. The
// author hook reads the same per-instance state — when the author runs,
// currentDir is already pointing at the correct trim side for this block.
//
// Surviving inherent count after author trim: floor(2N/3)+1 ≥ ceil(2N/3) → the
// minInputs gate is always satisfied (drops at most floor(N/3) quotes total).
//
// Nudge mode: identical to HonestValidator (attack only bites under median).
export class AsymmetricTrimChaserValidator extends BaseValidator {
  readonly type: ValidatorType = "asymmetric-trim-chaser";

  /** Per-instance latched direction the cabal is currently pushing the oracle.
   *   +1 = push UP (cluster above lastPrice, drop bottom floor(N/3)).
   *   -1 = push DOWN (cluster below lastPrice, drop top floor(N/3)).
   * Updated every block in produceQuoteInput; read in produceQuoteInherent.
   * Defaults to +1 so the author hook is well-defined even if it somehow
   * fires before produceQuoteInput on the same block. */
  private currentDir: 1 | -1 = 1;

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    const obs = this.observe(ctx.blockIndex);
    // Push the oracle FURTHER from real:
    //   obs > lastPrice → oracle below real → push DOWN (currentDir = -1)
    //   obs < lastPrice → oracle above real → push UP   (currentDir = +1)
    this.currentDir = obs >= ctx.lastPrice ? -1 : 1;
    return quote(
      this.index,
      ctx.lastPrice * (1 + this.currentDir * this.params.trimChaserBias),
    );
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    // Mirror HonestValidator nudge-mode behaviour exactly.
    const observed = this.observe(ctx.blockIndex);
    return nudge(this.index, observed >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  protected produceQuoteInherent(inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    // Filter to quote-kind only (drop bumps/abstains), then sort ascending.
    const quotes: Submission[] = [];
    for (const s of inputs) if (s.kind === "quote") quotes.push(s);
    quotes.sort((a, b) => {
      const pa = (a as { kind: "quote"; price: number }).price;
      const pb = (b as { kind: "quote"; price: number }).price;
      return pa - pb;
    });
    const dropCount = Math.floor(quotes.length / 3);
    if (dropCount <= 0) return quotes;
    if (this.currentDir === -1) {
      // Cabal pushing DOWN — cabal cluster is below; drop the top `dropCount`.
      return quotes.slice(0, quotes.length - dropCount);
    } else {
      // Cabal pushing UP — cabal cluster is above; drop the bottom `dropCount`.
      return quotes.slice(dropCount);
    }
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    // Mirror HonestValidator nudge-mode author selection exactly.
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const needed = optimalBumpCount(Math.abs(diff), ctx, inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

// ── AuthorOnlyTrimValidator ─────────────────────────────────────────────────
// Round-8 attack vector. Isolates the role of *author discretion*. The cabal
// quote leg is fully honest: every cabal member submits its own jittered
// observation `obs = this.observe(ctx.blockIndex)` exactly as a HonestValidator
// would. So on non-cabal-author blocks the median is computed from a clean
// 100-quote distribution and the cabal is invisible to per-validator audits.
//
// The bite is purely on cabal-author blocks: the author looks at its own
// observation vs lastPrice and decides which direction to push the oracle
// FURTHER from real, then asymmetrically trims floor(N/3) honest quotes from
// that side of the sorted distribution, biasing the surviving median.
//
//   obs >= lastPrice  → oracle below real → push DOWN.
//                       Sort quotes ascending; drop the TOP floor(N/3)
//                       (highest values). Surviving median lands lower.
//   obs <  lastPrice  → oracle above real → push UP.
//                       Drop the BOTTOM floor(N/3) (lowest values). Surviving
//                       median lands higher.
//
// Surviving inherent count: N − floor(N/3) ≥ floor(2N/3)+1, so the minInputs
// gate is always satisfied. This is the trim-edge author leg with NO cabal
// cluster — the question is whether author-side trim alone breaks median.
//
// Nudge mode: identical to HonestValidator (attack only bites under median).
export class AuthorOnlyTrimValidator extends BaseValidator {
  readonly type: ValidatorType = "author-only-trim";

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    // Honest quote — indistinguishable from HonestValidator on the wire.
    const obs = this.observe(ctx.blockIndex);
    return quote(this.index, obs);
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    // Mirror HonestValidator nudge-mode behaviour exactly.
    const observed = this.observe(ctx.blockIndex);
    return nudge(this.index, observed >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  protected produceQuoteInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    // Decide push direction from this author's own observation.
    //   dir = -1 → push DOWN (drop the TOP floor(N/3)).
    //   dir = +1 → push UP   (drop the BOTTOM floor(N/3)).
    const obs = this.observe(ctx.blockIndex);
    const dir: 1 | -1 = obs >= ctx.lastPrice ? -1 : 1;

    // Filter to quote-kind only (drop bumps/abstains), then sort ascending.
    const quotes: Submission[] = [];
    for (const s of inputs) if (s.kind === "quote") quotes.push(s);
    quotes.sort((a, b) => {
      const pa = (a as { kind: "quote"; price: number }).price;
      const pb = (b as { kind: "quote"; price: number }).price;
      return pa - pb;
    });
    const dropCount = Math.floor(quotes.length / 3);
    if (dropCount <= 0) return quotes;
    if (dir === -1) {
      // Push DOWN — drop the top `dropCount` (highest values).
      return quotes.slice(0, quotes.length - dropCount);
    } else {
      // Push UP — drop the bottom `dropCount` (lowest values).
      return quotes.slice(dropCount);
    }
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    // Mirror HonestValidator nudge-mode author selection exactly.
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const needed = optimalBumpCount(Math.abs(diff), ctx, inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

// ── DriftTrackTrimValidator ─────────────────────────────────────────────────
// Round-9 attack vector. A `trim-edge` variant that anchors the cabal cluster
// to the *original* injected target rather than the current `lastPrice`.
//
// The flaw exploited: in plain trim-edge, the cabal cluster moves with
// `lastPrice`, so when the oracle recovers between cabal-author blocks the
// cluster value follows the recovery and any cumulative damage is given back.
// Drift-track-trim instead latches `targetPrice` on the first block this
// instance sees and submits `targetPrice * (1 - driftTrackBias)` forever —
// regardless of how the oracle has drifted. As the oracle recovers, the cabal
// cluster stays put at the anchored level, so on the next cabal-author block
// the median is forced even further from real than before.
//
// Author hook is identical to trim-edge (down-direction): sort quotes
// ascending, drop the top floor(N/3). Surviving inherent count: N − floor(N/3)
// ≥ floor(2N/3)+1, so the minInputs gate is always satisfied.
//
// Nudge mode: identical to HonestValidator (attack only bites under median).
export class DriftTrackTrimValidator extends BaseValidator {
  readonly type: ValidatorType = "drift-track-trim";

  /** Per-instance anchor price. Initialised on the first block this validator
   *  produces a quote for; never updated thereafter. 0 acts as the
   *  uninitialised flag (lastPrice is always > 0 at runtime). */
  private targetPrice: number = 0;

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    if (this.targetPrice === 0) {
      this.targetPrice = ctx.lastPrice;
    }
    return quote(this.index, this.targetPrice * (1 - this.params.driftTrackBias));
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    // Mirror HonestValidator nudge-mode behaviour exactly.
    const observed = this.observe(ctx.blockIndex);
    return nudge(this.index, observed >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  protected produceQuoteInherent(inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    // Filter to quote-kind only (drop bumps/abstains), then sort ascending.
    const quotes: Submission[] = [];
    for (const s of inputs) if (s.kind === "quote") quotes.push(s);
    quotes.sort((a, b) => {
      const pa = (a as { kind: "quote"; price: number }).price;
      const pb = (b as { kind: "quote"; price: number }).price;
      return pa - pb;
    });
    const dropCount = Math.floor(quotes.length / 3);
    if (dropCount <= 0) return quotes;
    // Cabal at the bottom — drop the top `dropCount` (highest values).
    return quotes.slice(0, quotes.length - dropCount);
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    // Mirror HonestValidator nudge-mode author selection exactly.
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const needed = optimalBumpCount(Math.abs(diff), ctx, inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

// ── HoppingTrimValidator ────────────────────────────────────────────────────
// Round-10 attack vector. State-aware variant of TrimEdge that latches a push
// direction on first observation and HOLDS it for `hoppingHoldBlocks` blocks
// before re-evaluating. The slow direction switch eliminates the per-block
// oscillation cancellation that hobbled `asymmetric-trim-chaser` (round 7),
// while still letting the cabal recover an attack stance whenever the oracle
// is dragged back near real over a long enough hold.
//
// At lock time the cabal observes its own real price and picks the direction
// that pushes the oracle FURTHER from real:
//   obs >= lastPrice (oracle below real) → lockedDir = -1 (push DOWN)
//   obs <  lastPrice (oracle above real) → lockedDir = +1 (push UP)
//
//   Quote (every block):
//     submit `lastPrice * (1 + lockedDir * hoppingTrimBias)` (default 10%)
//   Author (every block):
//     sort gossiped quotes ascending; drop floor(N/3) from the side
//     OPPOSITE the cabal cluster:
//       lockedDir = -1 → cluster low, drop the top floor(N/3).
//       lockedDir = +1 → cluster high, drop the bottom floor(N/3).
//
// Surviving inherent count: N − floor(N/3) ≥ floor(2N/3)+1, so the minInputs
// gate is always satisfied. Honest jitter (~0.1%) is far smaller than the
// 10% cluster bias, so the surviving median lands at the cabal/inner-honest
// boundary on every cabal-author block until the next direction lock.
//
// Nudge mode: identical to HonestValidator (attack only bites under median).
export class HoppingTrimValidator extends BaseValidator {
  readonly type: ValidatorType = "hopping-trim";

  /** Currently latched push direction. 0 = uninitialised; the first
   *  produceQuoteInput call on this instance picks +1 or -1. */
  private lockedDir: 1 | -1 | 0 = 0;
  /** Block index at which `lockedDir` was last (re-)latched. -Infinity
   *  guarantees the first-block branch fires regardless of blockIndex. */
  private lockBlock: number = -Infinity;

  /** (Re-)evaluate the latched direction if uninitialised or the hold
   *  window has elapsed. Same observation logic as the chaser, but only
   *  fires every `hoppingHoldBlocks` blocks instead of every block. */
  private maybeRelatch(ctx: ProduceCtx): void {
    if (
      this.lockedDir === 0 ||
      ctx.blockIndex - this.lockBlock >= this.params.hoppingHoldBlocks
    ) {
      const obs = this.observe(ctx.blockIndex);
      // obs ≥ lastPrice → oracle below real → push DOWN (lockedDir = -1)
      // obs <  lastPrice → oracle above real → push UP   (lockedDir = +1)
      this.lockedDir = obs >= ctx.lastPrice ? -1 : 1;
      this.lockBlock = ctx.blockIndex;
    }
  }

  protected produceQuoteInput(ctx: ProduceCtx): Submission {
    this.maybeRelatch(ctx);
    const dir = this.lockedDir === 0 ? 1 : this.lockedDir;
    return quote(this.index, ctx.lastPrice * (1 + dir * this.params.hoppingTrimBias));
  }

  protected produceNudgeInput(ctx: ProduceCtx): Submission {
    // Mirror HonestValidator nudge-mode behaviour exactly.
    const observed = this.observe(ctx.blockIndex);
    return nudge(this.index, observed >= ctx.lastPrice ? Bump.Up : Bump.Down);
  }

  protected produceQuoteInherent(inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    // Filter to quote-kind only (drop bumps/abstains), then sort ascending.
    const quotes: Submission[] = [];
    for (const s of inputs) if (s.kind === "quote") quotes.push(s);
    quotes.sort((a, b) => {
      const pa = (a as { kind: "quote"; price: number }).price;
      const pb = (b as { kind: "quote"; price: number }).price;
      return pa - pb;
    });
    const dropCount = Math.floor(quotes.length / 3);
    if (dropCount <= 0) return quotes;
    // If somehow uninitialised, default to the same side as TrimEdge ("down").
    const dir = this.lockedDir === 0 ? -1 : this.lockedDir;
    if (dir === -1) {
      // Cabal pushing DOWN — cluster is below; drop the top `dropCount`.
      return quotes.slice(0, quotes.length - dropCount);
    } else {
      // Cabal pushing UP — cluster is above; drop the bottom `dropCount`.
      return quotes.slice(dropCount);
    }
  }

  protected produceNudgeInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    // Mirror HonestValidator nudge-mode author selection exactly.
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const needed = optimalBumpCount(Math.abs(diff), ctx, inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

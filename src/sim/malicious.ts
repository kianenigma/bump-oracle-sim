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
    return ctx.inputKind === "nudge"
      ? this.produceNudgeInput(ctx)
      : this.produceQuoteInput(ctx);
  }

  produceInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    if (inputs.length === 0) return [];
    return ctx.inputKind === "nudge"
      ? this.produceNudgeInherent(inputs, ctx)
      : this.produceQuoteInherent(inputs, ctx);
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
    const needed = optimalBumpCount(Math.abs(diff), ctx.epsilon, inputs.length);
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
    const needed = optimalBumpCount(Math.abs(diff), ctx.epsilon, inputs.length);
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

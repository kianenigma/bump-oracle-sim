import { Bump } from "../types.js";
import type { Submission, ValidatorParams, ValidatorPriceSource, ValidatorType } from "../types.js";
import {
  type InputKind,
  type ProduceCtx,
  type ValidatorAgent,
  optimalBumpCount,
  passThroughQuotes,
  pickInDirectionBumps,
} from "./validator.js";
import type { PriceEndpoint } from "./price-endpoint.js";

// All adversarial knobs (delayBlocks, pushyQuoteBias, driftQuoteStep) live on
// each group's `params` (per-group override) and fall back to
// DEFAULT_VALIDATOR_PARAMS in src/config.ts.

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

  protected observe(blockIndex: number): number {
    return this.endpoint.observe(this.priceSource, blockIndex, this.rng);
  }

  abstract produceInput(inputKind: InputKind, ctx: ProduceCtx): Submission;
  abstract produceInherent(inputs: Submission[], ctx: ProduceCtx): Submission[];
}

// ── MaliciousValidator ──────────────────────────────────────────────────────
// Inverse strategy. Pushes price *away* from real.
//   Nudge: emits the opposite direction; as author, activates same-direction
//          (away-from-real) bumps.
//   Quote: outlier `lastPrice − dir × bias × lastPrice`, where `dir` is the
//          direction of real motion and `bias = params.maliciousQuoteBias`.
//          Independent of how large the honest move is, so the attack lands
//          even on calm blocks. Higher bias → heavier push under mean and
//          near-50%-adversarial median. Under safe-median (<50% adversarial)
//          the magnitude is irrelevant; the attack is still wrong-side.
export class MaliciousValidator extends BaseValidator {
  readonly type: ValidatorType = "malicious";

  produceInput(inputKind: InputKind, ctx: ProduceCtx): Submission {
    const honest = this.observe(ctx.blockIndex);
    if (inputKind === "nudge") {
      return { kind: "nudge", validatorIndex: this.index, bump: honest >= ctx.lastPrice ? Bump.Down : Bump.Up };
    }
    const dir = honest >= ctx.lastPrice ? 1 : -1;
    const price = ctx.lastPrice - dir * ctx.lastPrice * this.params.maliciousQuoteBias;
    return { kind: "quote", validatorIndex: this.index, price };
  }

  produceInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    if (inputs.length === 0) return [];
    if (inputs[0].kind === "quote" || inputs[0].kind === "abstain") {
      // Quote mode: as author, select the subset of gossiped quotes whose
      // values pull the post-aggregation price AWAY from real. Concretely:
      //   real moving UP   → keep quotes < lastPrice (drag oracle DOWN)
      //   real moving DOWN → keep quotes > lastPrice (drag oracle UP)
      // The malicious validator's own input is already biased to the wrong
      // side (params.maliciousQuoteBias) so it is always included when bias>0.
      // This is the spec's "select honest prices that support your value"
      // attack — under median it shifts which value sits at the median
      // position; under mean it directly drops the supporting average.
      const observed = this.observe(ctx.blockIndex);
      const realDir = observed >= ctx.lastPrice ? 1 : -1;
      const out: Submission[] = [];
      for (const s of inputs) {
        if (s.kind !== "quote") continue;
        const supports = realDir === 1 ? s.price < ctx.lastPrice : s.price > ctx.lastPrice;
        if (supports) out.push(s);
      }
      return out;
    }
    // Nudge mode: pick bumps in the WRONG direction (away from real).
    const targetPrice = this.observe(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Down : Bump.Up;
    const needed = Math.min(Math.round(Math.abs(diff) / ctx.epsilon), inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

// ── PushyMaliciousValidator ─────────────────────────────────────────────────
//   Nudge: honest direction, but as author activates ALL in-direction bumps
//          (over-shoot via maximal push).
//   Quote: outlier in the direction of motion at magnitude `pushyQuoteBias`
//          of real price. Trivially rejected by median; visible vs trimmed.
export class PushyMaliciousValidator extends BaseValidator {
  readonly type: ValidatorType = "pushy";

  produceInput(inputKind: InputKind, ctx: ProduceCtx): Submission {
    const honest = this.observe(ctx.blockIndex);
    if (inputKind === "nudge") {
      return { kind: "nudge", validatorIndex: this.index, bump: honest >= ctx.lastPrice ? Bump.Up : Bump.Down };
    }
    const dir = honest >= ctx.lastPrice ? 1 : -1;
    return {
      kind: "quote",
      validatorIndex: this.index,
      price: honest + dir * this.params.pushyQuoteBias * honest,
    };
  }

  produceInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    if (inputs.length === 0) return [];
    if (inputs[0].kind === "quote" || inputs[0].kind === "abstain") {
      // Quote mode: as author, select the subset that pushes the resulting
      // price PAST real in the direction of motion (overshoot). Threshold is
      // `observed` (≈ real), not lastPrice — pushy's whole point is to land
      // beyond real, not just to move in the right direction:
      //   real moving UP   → keep quotes > observed (drag oracle ABOVE real)
      //   real moving DOWN → keep quotes < observed (drag oracle BELOW real)
      // Pushy's own input (`real ± bias × real`) is by construction past
      // observed, so it always survives. The author-censorship gap shows up
      // in totalBumps − activatedBumps (gossiped vs activated).
      const observed = this.observe(ctx.blockIndex);
      const realDir = observed >= ctx.lastPrice ? 1 : -1;
      const out: Submission[] = [];
      for (const s of inputs) {
        if (s.kind !== "quote") continue;
        const supports = realDir === 1 ? s.price > observed : s.price < observed;
        if (supports) out.push(s);
      }
      return out;
    }
    const targetPrice = this.observe(ctx.blockIndex);
    const direction = targetPrice >= ctx.lastPrice ? Bump.Up : Bump.Down;
    // Nudge mode: activate ALL in-direction bumps (max push, over-shoots).
    const out: Submission[] = [];
    for (const s of inputs) if (s.kind === "nudge" && s.bump === direction) out.push(s);
    return out;
  }
}

// ── NoopValidator ───────────────────────────────────────────────────────────
//   Nudge: emits honest bumps but as author activates none → freezes price.
//   Quote: abstains; as author drops the inherent entirely → freezes price.
//
// The "as author the chain freezes" behavior falls out naturally from
// produceInherent → []. No special-case in chain.ts.
export class NoopValidator extends BaseValidator {
  readonly type: ValidatorType = "noop";

  produceInput(inputKind: InputKind, ctx: ProduceCtx): Submission {
    if (inputKind === "nudge") {
      const honest = this.observe(ctx.blockIndex);
      return { kind: "nudge", validatorIndex: this.index, bump: honest >= ctx.lastPrice ? Bump.Up : Bump.Down };
    }
    return { kind: "abstain", validatorIndex: this.index };
  }

  produceInherent(_inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    return [];
  }
}

// ── DelayedValidator ────────────────────────────────────────────────────────
// Honest intent, but reads its observation from `delayBlocks` ago. Lags
// sharp moves; otherwise tracks reality.
export class DelayedValidator extends BaseValidator {
  readonly type: ValidatorType = "delayed";

  private observeStale(blockIndex: number): number {
    const stale = Math.max(0, blockIndex - this.params.delayBlocks);
    return this.endpoint.observe(this.priceSource, stale, this.rng);
  }

  produceInput(inputKind: InputKind, ctx: ProduceCtx): Submission {
    const stale = this.observeStale(ctx.blockIndex);
    if (inputKind === "nudge") {
      return { kind: "nudge", validatorIndex: this.index, bump: stale >= ctx.lastPrice ? Bump.Up : Bump.Down };
    }
    return { kind: "quote", validatorIndex: this.index, price: stale };
  }

  produceInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    if (inputs.length === 0) return [];
    if (inputs[0].kind === "quote" || inputs[0].kind === "abstain") {
      return passThroughQuotes(inputs);
    }
    const targetPrice = this.observeStale(ctx.blockIndex);
    const diff = targetPrice - ctx.lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const needed = optimalBumpCount(Math.abs(diff), ctx.epsilon, inputs.length);
    return pickInDirectionBumps(inputs, direction, needed);
  }
}

// ── DriftValidator ──────────────────────────────────────────────────────────
// Persistent upward bias, regardless of real price.
//   Nudge: always Up; as author activates all Up bumps.
//   Quote: lastPrice · (1 + driftQuoteStep) every block.
export class DriftValidator extends BaseValidator {
  readonly type: ValidatorType = "drift";

  produceInput(inputKind: InputKind, ctx: ProduceCtx): Submission {
    if (inputKind === "nudge") {
      return { kind: "nudge", validatorIndex: this.index, bump: Bump.Up };
    }
    return {
      kind: "quote",
      validatorIndex: this.index,
      price: ctx.lastPrice * (1 + this.params.driftQuoteStep),
    };
  }

  produceInherent(inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    if (inputs.length === 0) return [];
    if (inputs[0].kind === "quote" || inputs[0].kind === "abstain") {
      return passThroughQuotes(inputs);
    }
    const out: Submission[] = [];
    for (const s of inputs) if (s.kind === "nudge" && s.bump === Bump.Up) out.push(s);
    return out;
  }
}

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
//   Quote: mirrors the honest quote across lastPrice (price = 2·last − honest).
//          Same magnitude, wrong sign.
export class MaliciousValidator extends BaseValidator {
  readonly type: ValidatorType = "malicious";

  produceInput(inputKind: InputKind, ctx: ProduceCtx): Submission {
    const honest = this.observe(ctx.blockIndex);
    if (inputKind === "nudge") {
      return { kind: "nudge", validatorIndex: this.index, bump: honest >= ctx.lastPrice ? Bump.Down : Bump.Up };
    }
    return { kind: "quote", validatorIndex: this.index, price: 2 * ctx.lastPrice - honest };
  }

  produceInherent(inputs: Submission[], ctx: ProduceCtx): Submission[] {
    if (inputs.length === 0) return [];
    if (inputs[0].kind === "quote" || inputs[0].kind === "abstain") {
      // Quote mode: pass-through. The malicious quote itself is the attack.
      return passThroughQuotes(inputs);
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
      return passThroughQuotes(inputs);
    }
    const targetPrice = this.observe(ctx.blockIndex);
    const direction = targetPrice >= ctx.lastPrice ? Bump.Up : Bump.Down;
    // Activate ALL in-direction bumps (max push, over-shoots).
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

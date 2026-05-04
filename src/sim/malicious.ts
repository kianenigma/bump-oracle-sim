import { Bump } from "../types.js";
import type { BumpSubmission, MaliciousParams, Submission } from "../types.js";
import { optimalBumpCount, type ValidatorAgent } from "./validator.js";
import type { PriceEndpoint } from "./price-endpoint.js";

// All adversarial knobs (delayBlocks, pushyQuoteBias, driftQuoteStep) live on
// `MaliciousParams` in types.ts and are sourced from `SimulationConfig` so each
// scenario can vary them. Defaults are in src/config.ts (DEFAULT_MALICIOUS_PARAMS).

// TODO: validator with extra jitter
// TODO: 2 new bad validators: copy-pasta
// TODO: Bump(2x,4x,8x)
// TODO: allow onchain to receive a coefficient as well.

/**
 * Malicious validator that uses an inverse strategy:
 * - produceBump: returns the opposite direction of what an honest validator would
 * - producePrice: selects bumps to push the price away from the real price
 */
export class MaliciousValidator implements ValidatorAgent {
  readonly index: number;
  readonly isHonest = false;
  private endpoint: PriceEndpoint;
  private rng: () => number;
  private jitterStdDev: number;

  constructor(index: number, endpoint: PriceEndpoint, rng: () => number, jitterStdDev: number, _params: MaliciousParams) {
    this.index = index;
    this.endpoint = endpoint;
    this.rng = rng;
    this.jitterStdDev = jitterStdDev;
  }

  produceBump(lastPrice: number, blockIndex: number): Bump {
    const price = this.endpoint.getJitteredPrice(blockIndex, this.rng, this.jitterStdDev);
    // Inverse: if real price is above, bump down (opposite of honest)
    return price >= lastPrice ? Bump.Down : Bump.Up;
  }

  producePrice(
    bumps: BumpSubmission[],
    lastPrice: number,
    epsilon: number,
    blockIndex: number
  ): boolean[] {
    const targetPrice = this.endpoint.getJitteredPrice(blockIndex, this.rng, this.jitterStdDev);
    const diff = targetPrice - lastPrice;
    // Inverse direction: push price away from real
    const direction = diff >= 0 ? Bump.Down : Bump.Up;
    const neededBumps = Math.min(
      Math.round(Math.abs(diff) / epsilon),
      bumps.length
    );

    const mask = new Array(bumps.length).fill(false);
    let activated = 0;

    for (let i = 0; i < bumps.length && activated < neededBumps; i++) {
      if (bumps[i].bump === direction) {
        mask[i] = true;
        activated++;
      }
    }

    return mask;
  }

  // Quote mode: mirror the honest quote across lastPrice. If honest would have
  // submitted (lastPrice + delta), this submits (lastPrice - delta). Same magnitude,
  // wrong direction. Drags the median proportionally to the real movement.
  produceQuote(lastPrice: number, blockIndex: number): Submission {
    const honestQuote = this.endpoint.getJitteredPrice(blockIndex, this.rng, this.jitterStdDev);
    const mirrored = 2 * lastPrice - honestQuote;
    return { kind: "quote", validatorIndex: this.index, price: mirrored };
  }
}

/**
 * Malicious validator that uses this strategy:
 * - produceBump: do the right thing (honest bump)
 * - producePrice: select the correct direction (towards the real price), but maximally push (use ALL possible bumps in that direction)
 */
export class PushyMaliciousValidator implements ValidatorAgent {
  readonly index: number;
  readonly isHonest = false;
  private endpoint: PriceEndpoint;
  private rng: () => number;
  private jitterStdDev: number;
  private quoteBias: number;

  constructor(index: number, endpoint: PriceEndpoint, rng: () => number, jitterStdDev: number, params: MaliciousParams) {
    this.index = index;
    this.endpoint = endpoint;
    this.rng = rng;
    this.jitterStdDev = jitterStdDev;
    this.quoteBias = params.pushyQuoteBias;
  }

  // Honest (correct) bump direction based on real price with jitter
  produceBump(lastPrice: number, blockIndex: number): Bump {
    const price = this.endpoint.getJitteredPrice(blockIndex, this.rng, this.jitterStdDev);
    return price >= lastPrice ? Bump.Up : Bump.Down;
  }

  // Maximally pushes price in the direction of the true price: select all bumps in the correct direction
  producePrice(
    bumps: BumpSubmission[],
    lastPrice: number,
    epsilon: number,
    blockIndex: number
  ): boolean[] {
    const targetPrice = this.endpoint.getJitteredPrice(blockIndex, this.rng, this.jitterStdDev);
    const diff = targetPrice - lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;

    // Activate all bumps in the correct direction, regardless of neededBumps
    return bumps.map(b => b.bump === direction);
  }

  // Quote mode: pushy's nudge attack ("max push as author") has no equivalent
  // under runtime aggregation — the author has no aggregation power. Best
  // available translation is "submit an extreme outlier in the direction of
  // motion". This is structurally weak vs. median (which trivially rejects
  // outliers below 50%) but visible in trimmed mean if it sneaks past trimming.
  produceQuote(lastPrice: number, blockIndex: number): Submission {
    const realObs = this.endpoint.getJitteredPrice(blockIndex, this.rng, this.jitterStdDev);
    const dir = realObs >= lastPrice ? 1 : -1;
    const price = realObs + dir * this.quoteBias * realObs;
    return { kind: "quote", validatorIndex: this.index, price };
  }
}

/**
 * No-op validator: submits honest bumps but as block author activates nothing.
 * Models a stalling/censoring author that freezes the oracle price.
 */
export class NoopValidator implements ValidatorAgent {
  readonly index: number;
  readonly isHonest = false;
  private endpoint: PriceEndpoint;
  private rng: () => number;
  private jitterStdDev: number;

  constructor(index: number, endpoint: PriceEndpoint, rng: () => number, jitterStdDev: number, _params: MaliciousParams) {
    this.index = index;
    this.endpoint = endpoint;
    this.rng = rng;
    this.jitterStdDev = jitterStdDev;
  }

  produceBump(lastPrice: number, blockIndex: number): Bump {
    const price = this.endpoint.getJitteredPrice(blockIndex, this.rng, this.jitterStdDev);
    return price >= lastPrice ? Bump.Up : Bump.Down;
  }

  producePrice(bumps: BumpSubmission[]): boolean[] {
    return new Array(bumps.length).fill(false);
  }

  // Quote mode: noop abstains. Non-abstain submissions get aggregated normally,
  // so the only effect of a noop validator is to shrink the sample. The
  // "noop-author freezes the chain" attack is handled separately in chain.ts:
  // when this validator authors a block under a non-nudge aggregator, the chain
  // skips aggregation entirely and the price stays put.
  produceQuote(_lastPrice: number, _blockIndex: number): Submission {
    return { kind: "abstain", validatorIndex: this.index };
  }
}

/**
 * Delayed validator: honest intent but reads a stale price from DELAY_BLOCKS ago.
 * Models realistic network latency or cached/slow price feeds.
 */
export class DelayedValidator implements ValidatorAgent {
  readonly index: number;
  readonly isHonest = false;
  private endpoint: PriceEndpoint;
  private rng: () => number;
  private jitterStdDev: number;
  private delayBlocks: number;

  constructor(index: number, endpoint: PriceEndpoint, rng: () => number, jitterStdDev: number, params: MaliciousParams) {
    this.index = index;
    this.endpoint = endpoint;
    this.rng = rng;
    this.jitterStdDev = jitterStdDev;
    this.delayBlocks = params.delayBlocks;
  }

  private staleIndex(blockIndex: number): number {
    return Math.max(0, blockIndex - this.delayBlocks);
  }

  produceBump(lastPrice: number, blockIndex: number): Bump {
    const price = this.endpoint.getJitteredPrice(this.staleIndex(blockIndex), this.rng, this.jitterStdDev);
    return price >= lastPrice ? Bump.Up : Bump.Down;
  }

  producePrice(
    bumps: BumpSubmission[],
    lastPrice: number,
    epsilon: number,
    blockIndex: number
  ): boolean[] {
    const targetPrice = this.endpoint.getJitteredPrice(this.staleIndex(blockIndex), this.rng, this.jitterStdDev);
    const diff = targetPrice - lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const neededBumps = optimalBumpCount(Math.abs(diff), epsilon, bumps.length);

    const mask = new Array(bumps.length).fill(false);
    let activated = 0;
    for (let i = 0; i < bumps.length && activated < neededBumps; i++) {
      if (bumps[i].bump === direction) {
        mask[i] = true;
        activated++;
      }
    }
    return mask;
  }

  // Quote mode: same intent as nudge mode — submit a quote based on a stale
  // price from `delayBlocks` ago. Direction-correct on average but lagging
  // sharp moves.
  produceQuote(_lastPrice: number, blockIndex: number): Submission {
    const price = this.endpoint.getJitteredPrice(this.staleIndex(blockIndex), this.rng, this.jitterStdDev);
    return { kind: "quote", validatorIndex: this.index, price };
  }
}

/**
 * Drift validator: always bumps Up and as author activates all Up bumps.
 * Models a griefing attacker that tries to create persistent upward drift.
 */
export class DriftValidator implements ValidatorAgent {
  readonly index: number;
  readonly isHonest = false;
  private endpoint: PriceEndpoint;
  private rng: () => number;
  private jitterStdDev: number;
  private quoteStep: number;

  constructor(index: number, endpoint: PriceEndpoint, rng: () => number, jitterStdDev: number, params: MaliciousParams) {
    this.index = index;
    this.endpoint = endpoint;
    this.rng = rng;
    this.jitterStdDev = jitterStdDev;
    this.quoteStep = params.driftQuoteStep;
  }

  produceBump(): Bump {
    return Bump.Up;
  }

  producePrice(bumps: BumpSubmission[]): boolean[] {
    return bumps.map(b => b.bump === Bump.Up);
  }

  // Quote mode: persistent upward bias, regardless of real price.
  produceQuote(lastPrice: number, _blockIndex: number): Submission {
    return { kind: "quote", validatorIndex: this.index, price: lastPrice * (1 + this.quoteStep) };
  }
}

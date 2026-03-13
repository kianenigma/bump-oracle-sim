import { Bump } from "../types.js";
import type { BumpSubmission } from "../types.js";
import type { ValidatorAgent } from "./validator.js";
import type { PriceEndpoint } from "./price-endpoint.js";

// How many blocks behind the DelayedValidator reads its price (60s at 6s blocks)
const DELAY_BLOCKS = 10;

// TODO: validator with extra jitter
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

  constructor(index: number, endpoint: PriceEndpoint, rng: () => number, jitterStdDev: number) {
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

  constructor(index: number, endpoint: PriceEndpoint, rng: () => number, jitterStdDev: number) {
    this.index = index;
    this.endpoint = endpoint;
    this.rng = rng;
    this.jitterStdDev = jitterStdDev;
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

  constructor(index: number, endpoint: PriceEndpoint, rng: () => number, jitterStdDev: number) {
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

  constructor(index: number, endpoint: PriceEndpoint, rng: () => number, jitterStdDev: number) {
    this.index = index;
    this.endpoint = endpoint;
    this.rng = rng;
    this.jitterStdDev = jitterStdDev;
  }

  private staleIndex(blockIndex: number): number {
    return Math.max(0, blockIndex - DELAY_BLOCKS);
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

  constructor(index: number, endpoint: PriceEndpoint, rng: () => number, jitterStdDev: number) {
    this.index = index;
    this.endpoint = endpoint;
    this.rng = rng;
    this.jitterStdDev = jitterStdDev;
  }

  produceBump(): Bump {
    return Bump.Up;
  }

  producePrice(bumps: BumpSubmission[]): boolean[] {
    return bumps.map(b => b.bump === Bump.Up);
  }
}

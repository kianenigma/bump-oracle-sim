import { Bump } from "../types.js";
import type { BumpSubmission } from "../types.js";
import type { PriceEndpoint } from "./price-endpoint.js";

export interface ValidatorAgent {
  readonly index: number;
  readonly isHonest: boolean;

  /** Produce a bump (Up or Down) based on the validator's view of the price */
  produceBump(lastPrice: number, blockIndex: number): Bump;

  /** As block author, select which bumps to activate. Returns a boolean mask. */
  producePrice(
    bumps: BumpSubmission[],
    lastPrice: number,
    epsilon: number,
    blockIndex: number
  ): boolean[];
}

export class HonestValidator implements ValidatorAgent {
  readonly index: number;
  readonly isHonest = true;
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

  producePrice(
    bumps: BumpSubmission[],
    lastPrice: number,
    epsilon: number,
    blockIndex: number
  ): boolean[] {
    const targetPrice = this.endpoint.getJitteredPrice(blockIndex, this.rng, this.jitterStdDev);
    const diff = targetPrice - lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const neededBumps = Math.min(
      Math.round(Math.abs(diff) / epsilon),
      bumps.length
    );

    // Activate bumps in the desired direction, up to neededBumps
    const mask = new Array(bumps.length).fill(false);
    let activated = 0;

    // First pass: pick bumps in the right direction
    for (let i = 0; i < bumps.length && activated < neededBumps; i++) {
      if (bumps[i].bump === direction) {
        mask[i] = true;
        activated++;
      }
    }

    return mask;
  }
}

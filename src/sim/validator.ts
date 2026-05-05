import { Bump } from "../types.js";
import type { BumpSubmission, MaliciousParams, Submission, ValidatorPriceSource } from "../types.js";
import type { PriceEndpoint } from "./price-endpoint.js";

export interface ValidatorAgent {
  readonly index: number;
  readonly isHonest: boolean;

  /** Produce a bump (Up or Down) based on the validator's view of the price.
   *  Used only by the "nudge" aggregator. */
  produceBump(lastPrice: number, blockIndex: number): Bump;

  /** As block author, select which bumps to activate. Returns a boolean mask.
   *  Used only by the "nudge" aggregator. */
  producePrice(
    bumps: BumpSubmission[],
    lastPrice: number,
    epsilon: number,
    blockIndex: number
  ): boolean[];

  /** Submit an absolute price quote (or abstain) for runtime aggregation.
   *  Used by the "median" and "trimmed-mean" aggregators. */
  produceQuote(lastPrice: number, blockIndex: number): Submission;
}

/**
 * Computes the number of bumps that minimizes |absDiff - n * epsilon|.
 * Only rounds up when doing so STRICTLY reduces deviation (ties prefer fewer bumps).
 * This avoids unnecessary price movements caused by jitter noise.
 */
export function optimalBumpCount(absDiff: number, epsilon: number, maxBumps: number): number {
  if (epsilon <= 0 || maxBumps <= 0) return 0;
  const base = Math.floor(absDiff / epsilon);
  if (base >= maxBumps) return maxBumps;

  const baseDev = absDiff - base * epsilon;       // deviation with `base` bumps
  const nextDev = (base + 1) * epsilon - absDiff; // deviation with `base + 1` bumps

  return nextDev < baseDev ? Math.min(base + 1, maxBumps) : base;
}

export class HonestValidator implements ValidatorAgent {
  readonly index: number;
  readonly isHonest = true;
  protected endpoint: PriceEndpoint;
  protected rng: () => number;
  protected jitterStdDev: number;
  protected priceSource: ValidatorPriceSource;

  constructor(
    index: number,
    endpoint: PriceEndpoint,
    rng: () => number,
    jitterStdDev: number,
    _params: MaliciousParams,
    priceSource: ValidatorPriceSource,
  ) {
    this.index = index;
    this.endpoint = endpoint;
    this.rng = rng;
    this.jitterStdDev = jitterStdDev;
    this.priceSource = priceSource;
  }

  /** This validator's observation of the price at the given block, applying
   *  jitter and respecting `priceSource` (median vs random-venue). */
  protected observe(blockIndex: number): number {
    return this.endpoint.observe(this.priceSource, blockIndex, this.rng, this.jitterStdDev);
  }

  produceBump(lastPrice: number, blockIndex: number): Bump {
    const price = this.observe(blockIndex);
    return price >= lastPrice ? Bump.Up : Bump.Down;
  }

  producePrice(
    bumps: BumpSubmission[],
    lastPrice: number,
    epsilon: number,
    blockIndex: number
  ): boolean[] {
    const targetPrice = this.observe(blockIndex);
    const diff = targetPrice - lastPrice;
    const direction = diff >= 0 ? Bump.Up : Bump.Down;
    const neededBumps = optimalBumpCount(Math.abs(diff), epsilon, bumps.length);

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

  // Honest quote = the validator's local observation, exactly the same value
  // it would use to derive its bump direction.
  produceQuote(_lastPrice: number, blockIndex: number): Submission {
    return { kind: "quote", validatorIndex: this.index, price: this.observe(blockIndex) };
  }
}

import { Bump } from "../types.js";
import type { BumpSubmission, BlockMetrics } from "../types.js";
import type { ValidatorAgent } from "./validator.js";
import type { PriceEndpoint } from "./price-endpoint.js";

export class Chain {
  block: number = 0;
  lastPrice: number;
  epsilon: number;

  private validators: ValidatorAgent[];
  private endpoint: PriceEndpoint;
  private rng: () => number;

  constructor(
    initialPrice: number,
    epsilon: number,
    validators: ValidatorAgent[],
    endpoint: PriceEndpoint,
    rng: () => number
  ) {
    this.lastPrice = initialPrice;
    this.epsilon = epsilon;
    this.validators = validators;
    this.endpoint = endpoint;
    this.rng = rng;
  }

  nextBlock(): BlockMetrics {
    const blockIndex = this.block;
    const realPrice = this.endpoint.getRealPrice(blockIndex);
    const timestamp = this.endpoint.getTimestamp(blockIndex);

    // 1. All validators produce bumps
    const bumps: BumpSubmission[] = this.validators.map((v) => ({
      validatorIndex: v.index,
      bump: v.produceBump(this.lastPrice, blockIndex),
    }));

    // 2. Pick a random author from ALL validators (proportional to mix)
    const author = this.validators[Math.floor(this.rng() * this.validators.length)];

    // 3. Author selects which bumps to activate
    const mask = author.producePrice(bumps, this.lastPrice, this.epsilon, blockIndex);

    // 4. Calculate net bumps from activated submissions
    let netBumps = 0;
    let activatedCount = 0;
    for (let i = 0; i < bumps.length; i++) {
      if (mask[i]) {
        netBumps += bumps[i].bump; // Up=+1, Down=-1
        activatedCount++;
      }
    }

    // 5. Update price
    this.lastPrice += netBumps * this.epsilon;

    const deviation = Math.abs(realPrice - this.lastPrice);
    const deviationPct = realPrice !== 0 ? (deviation / realPrice) * 100 : 0;

    const metrics: BlockMetrics = {
      block: blockIndex,
      timestamp,
      realPrice,
      oraclePrice: this.lastPrice,
      authorIndex: author.index,
      authorIsHonest: author.isHonest,
      totalBumps: bumps.length,
      activatedBumps: activatedCount,
      netDirection: netBumps,
      deviation,
      deviationPct,
    };

    // 6. Increment block
    this.block++;

    return metrics;
  }
}

import type { BlockMetrics, EpsilonMode, Submission } from "../types.js";
import type { ValidatorAgent } from "./validator.js";
import type { PriceEndpoint } from "./price-endpoint.js";
import type { Aggregator } from "./aggregator.js";
import { NoopValidator } from "./malicious.js";

export class Chain {
  block: number = 0;
  lastPrice: number;
  epsilon: number;
  epsilonMode: EpsilonMode;

  private validators: ValidatorAgent[];
  private endpoint: PriceEndpoint;
  private rng: () => number;
  private aggregator: Aggregator;

  constructor(
    initialPrice: number,
    epsilon: number,
    epsilonMode: EpsilonMode,
    validators: ValidatorAgent[],
    endpoint: PriceEndpoint,
    rng: () => number,
    aggregator: Aggregator,
  ) {
    this.lastPrice = initialPrice;
    this.epsilon = epsilon;
    this.epsilonMode = epsilonMode;
    this.validators = validators;
    this.endpoint = endpoint;
    this.rng = rng;
    this.aggregator = aggregator;
  }

  nextBlock(): BlockMetrics {
    const blockIndex = this.block;
    const realPrice = this.endpoint.getRealPrice(blockIndex);
    const timestamp = this.endpoint.getTimestamp(blockIndex);

    // Effective epsilon for this block (only consulted by NudgeAggregator).
    const effectiveEps = this.epsilonMode === "ratio"
      ? this.lastPrice * this.epsilon
      : this.epsilon;

    // Pick author from ALL validators. Author still matters for nudge mode
    // (selects bumps) and for the noop-author special case below.
    const author = this.validators[Math.floor(this.rng() * this.validators.length)];

    // Noop-author special case: in nudge mode this is naturally enforced by
    // NoopValidator.producePrice() returning all-false. Under runtime aggregation
    // the author has no aggregation power, so the closest analog is "the author
    // refused to include the inherent at all" — we model that by skipping
    // aggregation entirely and holding the price.
    const noopAuthorBlocked =
      this.aggregator.submissionKind === "quote" && author instanceof NoopValidator;

    let totalBumps = 0;
    let activatedBumps = 0;
    let netDirection = 0;

    if (!noopAuthorBlocked) {
      // Collect submissions in the shape this aggregator wants.
      const submissions: Submission[] = new Array(this.validators.length);
      if (this.aggregator.submissionKind === "nudge") {
        for (let i = 0; i < this.validators.length; i++) {
          const v = this.validators[i];
          submissions[i] = { kind: "nudge", validatorIndex: v.index, bump: v.produceBump(this.lastPrice, blockIndex) };
        }
      } else {
        for (let i = 0; i < this.validators.length; i++) {
          submissions[i] = this.validators[i].produceQuote(this.lastPrice, blockIndex);
        }
      }

      const out = this.aggregator.aggregate({
        submissions,
        lastPrice: this.lastPrice,
        author,
        epsilon: effectiveEps,
        blockIndex,
      });
      this.lastPrice = out.newPrice;
      totalBumps = out.totalBumps;
      activatedBumps = out.activatedBumps;
      netDirection = out.netDirection;
    }

    const deviation = Math.abs(realPrice - this.lastPrice);
    const deviationPct = realPrice !== 0 ? (deviation / realPrice) * 100 : 0;

    const metrics: BlockMetrics = {
      block: blockIndex,
      timestamp,
      realPrice,
      oraclePrice: this.lastPrice,
      authorIndex: author.index,
      authorIsHonest: author.isHonest,
      totalBumps,
      activatedBumps,
      netDirection,
      deviation,
      deviationPct,
    };

    this.block++;
    return metrics;
  }
}

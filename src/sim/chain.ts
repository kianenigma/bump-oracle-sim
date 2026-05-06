import type { BlockMetrics, EpsilonMode, Submission } from "../types.js";
import type { ProduceCtx, ValidatorAgent } from "./validator.js";
import type { PriceEndpoint } from "./price-endpoint.js";
import type { Aggregator } from "./aggregator.js";

/**
 * The strict per-block flow modeled here matches the spec:
 *
 *   1. Chain asks every validator for its `input` (a nudge or quote).
 *   2. Chain selects one random validator as block author.
 *   3. Chain hands all gossiped inputs to the author.
 *      Author returns the block-inherent (subset selected to include).
 *   4. Chain hands the inherent to its aggregator (the runtime).
 *      Aggregator computes the new price.
 *   5. Deviation vs. real price (mean of venues by default) is recorded.
 *
 * No carve-outs. Behaviors like "noop author freezes the chain" fall out
 * naturally because NoopValidator.produceInherent returns [] and the
 * aggregator holds the price on empty inherent.
 */
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

    const effectiveEps = this.epsilonMode === "ratio"
      ? this.lastPrice * this.epsilon
      : this.epsilon;

    const ctx: ProduceCtx = {
      lastPrice: this.lastPrice,
      blockIndex,
      epsilon: effectiveEps,
    };

    // 1. Gather one input per validator (offchain gossip).
    const inputKind = this.aggregator.inputKind;
    const inputs: Submission[] = new Array(this.validators.length);
    for (let i = 0; i < this.validators.length; i++) {
      inputs[i] = this.validators[i].produceInput(inputKind, ctx);
    }

    // 2. Pick a uniformly random author from ALL validators.
    const author = this.validators[Math.floor(this.rng() * this.validators.length)];

    // 3. Author selects which inputs go into the block inherent.
    const inherent = author.produceInherent(inputs, ctx);

    // 4. Aggregator (runtime) consumes the inherent → new price.
    const out = this.aggregator.apply({
      inputs,
      inherent,
      lastPrice: this.lastPrice,
      epsilon: effectiveEps,
    });
    this.lastPrice = out.newPrice;

    // Inherent composition. Abstains are excluded (they never end up in an
    // inherent in practice, but the guard keeps the count semantically clean).
    // Non-honest = any validator with isHonest === false (malicious, pushy,
    // noop, delayed, drift). The percentage is reported alongside the raw
    // counts so the CSV reader doesn't have to renormalize when comparing
    // blocks with different inherent sizes.
    let inherentTotal = 0;
    let inherentNonHonest = 0;
    for (const s of inherent) {
      if (s.kind === "abstain") continue;
      inherentTotal++;
      if (!this.validators[s.validatorIndex].isHonest) inherentNonHonest++;
    }
    const inherentNonHonestPct = inherentTotal === 0 ? 0 : (inherentNonHonest / inherentTotal) * 100;

    const deviation = Math.abs(realPrice - this.lastPrice);
    const deviationPct = realPrice !== 0 ? (deviation / realPrice) * 100 : 0;

    const metrics: BlockMetrics = {
      block: blockIndex,
      timestamp,
      realPrice,
      oraclePrice: this.lastPrice,
      authorIndex: author.index,
      authorIsHonest: author.isHonest,
      authorType: author.type,
      totalBumps: out.totalBumps,
      activatedBumps: out.activatedBumps,
      netDirection: out.netDirection,
      inherentTotal,
      inherentNonHonest,
      inherentNonHonestPct,
      deviation,
      deviationPct,
    };

    this.block++;
    return metrics;
  }
}

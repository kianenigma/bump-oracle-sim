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
      inputKind: this.aggregator.inputKind,
      validatorCount: this.validators.length,
    };

    // 1. Gather one input per validator (offchain gossip). Validators that
    // return `null` are abstaining — they simply don't appear in the gossip.
    const inputs: Submission[] = [];
    for (let i = 0; i < this.validators.length; i++) {
      const s = this.validators[i].produceInput(ctx);
      if (s !== null) inputs.push(s);
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

    // Inherent composition. Non-honest = any validator with isHonest === false
    // (malicious, pushy, pushy-max, noop, delayed, drift, withholder). The
    // percentage is reported alongside the raw counts so the CSV reader doesn't
    // have to renormalize when comparing blocks with different inherent sizes.
    let inherentTotal = 0;
    let inherentNonHonest = 0;
    // Build per-block inherentVotes only for median-mode (quote-input) runs;
    // nudge inherents are bumps, not value quotes, so the list would be
    // meaningless. The aggregator's inputKind tells us which mode we're in.
    const trackInherentVotes = this.aggregator.inputKind === "quote";
    const inherentVotes: BlockMetrics["inherentVotes"] = trackInherentVotes ? [] : undefined;
    for (const s of inherent) {
      inherentTotal++;
      const v = this.validators[s.validatorIndex];
      if (!v.isHonest) inherentNonHonest++;
      if (inherentVotes && s.kind === "quote") {
        inherentVotes.push({ type: v.type, price: s.price });
      }
    }
    const inherentNonHonestPct = inherentTotal === 0 ? 0 : (inherentNonHonest / inherentTotal) * 100;

    const deviation = Math.abs(realPrice - this.lastPrice);
    const deviationPct = realPrice !== 0 ? (deviation / realPrice) * 100 : 0;

    let medianValidatorIndex: number | undefined;
    let medianValidatorType: BlockMetrics["medianValidatorType"];
    if (out.medianValidatorIndex !== undefined) {
      medianValidatorIndex = out.medianValidatorIndex;
      medianValidatorType = this.validators[out.medianValidatorIndex]?.type;
    }

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
      priceUpdated: out.priceUpdated,
      medianValidatorIndex,
      medianValidatorType,
      inherentVotes,
      deviation,
      deviationPct,
    };

    this.block++;
    return metrics;
  }
}

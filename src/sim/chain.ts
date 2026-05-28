import type { BlockMetrics, Submission } from "../types.js";
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
 *   3b. Chain asks the author whether to opt into the pending velocity
 *      boost (optional `wantVelocityBoost`; defaults to false).
 *   4. Chain calls `onBeforeApply` so the aggregator can finalize per-block
 *      state from the just-built inherent (e.g. nudge's velocity gate).
 *   5. Chain hands the inherent to its aggregator (the runtime).
 *      Aggregator computes the new price.
 *   6. Chain notifies the aggregator via `onBlockEnd` so it can propose any
 *      next-block state changes (e.g. nudge's velocity proposal).
 *   7. Deviation vs. real price (mean of venues by default) is recorded.
 *
 * No carve-outs. Behaviors like "noop author freezes the chain" fall out
 * naturally because NoopValidator.produceInherent returns [] and the
 * aggregator holds the price on empty inherent.
 */
export class Chain {
  block: number = 0;
  lastPrice: number;

  private validators: ValidatorAgent[];
  private endpoint: PriceEndpoint;
  private rng: () => number;
  private aggregator: Aggregator;

  constructor(
    initialPrice: number,
    validators: ValidatorAgent[],
    endpoint: PriceEndpoint,
    rng: () => number,
    aggregator: Aggregator,
  ) {
    this.lastPrice = initialPrice;
    this.validators = validators;
    this.endpoint = endpoint;
    this.rng = rng;
    this.aggregator = aggregator;
  }

  nextBlock(): BlockMetrics {
    const blockIndex = this.block;
    const realPrice = this.endpoint.getRealPrice(blockIndex);
    const timestamp = this.endpoint.getTimestamp(blockIndex);

    // The aggregator owns per-block parameters (ε for nudge, nothing for
    // median). Chain just asks for the variant and threads it through.
    const ctx: ProduceCtx = {
      lastPrice: this.lastPrice,
      blockIndex,
      inputKind: this.aggregator.inputKindFor(this.lastPrice),
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

    // 3b. Ask the author whether they want to consume any pending velocity
    // boost this block. Optional method — validators that don't implement
    // it default to `false` (no boost).
    const wantBoost = author.wantVelocityBoost?.(inherent, ctx) ?? false;

    // 4. Aggregator decides per-block ε based on the just-built inherent
    // (velocity gate-check happens here for nudge; no-op for median).
    const validatorCount = this.validators.length;
    this.aggregator.onBeforeApply({ inherent, wantBoost, validatorCount });

    // 5. Aggregator (runtime) consumes the inherent → new price.
    const oldPrice = this.lastPrice;
    const out = this.aggregator.apply({
      inputs,
      inherent,
      lastPrice: oldPrice,
      validatorCount,
    });
    this.lastPrice = out.newPrice;

    // 6. End-of-block hook: aggregator updates any internal per-run state
    // (e.g. nudge's velocity-based ε schedule — proposes the next-block
    // coefficient).
    this.aggregator.onBlockEnd({
      oldPrice,
      newPrice: out.newPrice,
      inherent,
      validatorCount,
    });

    // Inherent composition. Non-honest = any validator with isHonest === false
    // (malicious, pushy, pushy-max, noop, delayed, drift, withholder). The
    // percentage is reported alongside the raw counts so the CSV reader doesn't
    // have to renormalize when comparing blocks with different inherent sizes.
    let inherentTotal = 0;
    let inherentNonHonest = 0;
    // Per-block inherentVotes is populated for BOTH aggregator modes so the
    // CSV always carries the full per-block author selection. Median-mode
    // entries carry `price`; nudge-mode entries carry `bump` (±1). Cost is
    // O(inherentSize) per block, which is the same scan we're already doing
    // for the count totals.
    const inherentVotes: BlockMetrics["inherentVotes"] = [];
    for (const s of inherent) {
      inherentTotal++;
      const v = this.validators[s.validatorIndex];
      if (!v.isHonest) inherentNonHonest++;
      if (s.kind === "quote") {
        inherentVotes.push({ kind: "quote", type: v.type, price: s.price });
      } else if (s.kind === "nudge") {
        inherentVotes.push({ kind: "nudge", type: v.type, bump: s.bump });
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
      agreementRate: out.agreementRate,
      epsilonCoefficient: out.epsilonCoefficient,
      inherentVotes,
      deviation,
      deviationPct,
    };

    this.block++;
    return metrics;
  }
}

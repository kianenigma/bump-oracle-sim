import type { Submission, VenueId } from "../types.js";
import type { ProduceCtx, ValidatorAgent } from "../sim/validator.js";
import { passThroughQuotes } from "../sim/validator.js";
import { gaussianRandom } from "../rng.js";
import { computeMiniOracle } from "./mini-oracle.js";
import type { FeedSnapshot, MiniOracleOptions, MiniOracleTrace } from "./types.js";

/** Provides the shared per-block snapshot + pipeline options to validators. */
export interface LiveObservationSource {
  snapshot(): FeedSnapshot;
  pipelineOptions(): MiniOracleOptions;
}

/**
 * An honest live validator: runs the full Mini Oracle CEX-only pipeline over
 * ITS OWN view of the shared feed (a per-validator venue subset), adds its
 * observation jitter, and submits the result as a latched-median quote.
 *
 * Diversity model: all validators share one fetch layer (see LiveFeed), but
 * each sees a different venue subset — so their pipelines genuinely disagree
 * the way independently-operated validators would.
 */
export class LiveHonestValidator implements ValidatorAgent {
  readonly index: number;
  readonly type = "honest" as const;
  readonly isHonest = true;
  readonly venues: VenueId[];

  private source: LiveObservationSource;
  private rng: () => number;
  private jitterStdDev: number;

  /** Pipeline audit of the most recent produceInput (block-detail UI). */
  lastTrace: MiniOracleTrace | null = null;
  /** Final (jittered) quote of the most recent produceInput; null = abstained. */
  lastQuote: number | null = null;

  constructor(
    index: number,
    venues: VenueId[],
    source: LiveObservationSource,
    rng: () => number,
    jitterStdDev: number,
  ) {
    if (venues.length === 0) throw new Error(`LiveHonestValidator #${index}: empty venue subset`);
    this.index = index;
    this.venues = venues;
    this.source = source;
    this.rng = rng;
    this.jitterStdDev = jitterStdDev;
  }

  produceInput(_ctx: ProduceCtx): Submission | null {
    const snap = this.source.snapshot();
    const visible = snap.points.filter((p) => this.venues.includes(p.venue));
    const trace = computeMiniOracle(visible, this.source.pipelineOptions());
    this.lastTrace = trace;
    if (trace.quote === null) {
      this.lastQuote = null;
      return null; // nothing usable → abstain; the latched set carries us
    }
    const price = this.jitterStdDev > 0
      ? gaussianRandom(this.rng, trace.quote, trace.quote * this.jitterStdDev)
      : trace.quote;
    this.lastQuote = price;
    return { kind: "quote", validatorIndex: this.index, type: this.type, price };
  }

  produceInherent(inputs: Submission[], _ctx: ProduceCtx): Submission[] {
    return passThroughQuotes(inputs);
  }
}

/** Deterministically pick a venue subset for validator `index`: shuffle the
 *  venue list with the validator's own rng and take the first `size`. */
export function pickVenueSubset(venues: VenueId[], size: number, rng: () => number): VenueId[] {
  const pool = venues.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(1, Math.min(size, pool.length)));
}

import type { PricePoint, SimulationConfig, VenueId } from "../types.js";
import { mulberry32 } from "../rng.js";
import { PriceEndpoint } from "../sim/price-endpoint.js";
import { Chain } from "../sim/chain.js";
import { LatchedMedianAggregator } from "../sim/aggregator.js";
import { LiveFeed } from "./feed.js";
import { venueUsdPrices } from "./mini-oracle.js";
import { LiveHonestValidator, pickVenueSubset, type LiveObservationSource } from "./validator.js";
import { LiveStore } from "./store.js";
import { startLiveServer } from "./server.js";
import type { FeedSnapshot, LiveBlockRecord, LiveSubmissionRecord, MiniOracleTrace } from "./types.js";
import { BLOCK_TIME_SECONDS } from "../config.js";

export interface LiveRunOptions {
  validatorCount: number;
  venues: VenueId[];
  seed: number;
  jitterStdDev: number;
  /** MAD outlier multiplier (design doc leaves k open; default 3). */
  madK: number;
  /** Venues each validator sees (subset of `venues`; default 4). */
  subsetSize: number;
  convergenceThreshold: number;
  outputDir: string;
  port: number;
  openBrowser: boolean;
}

const VOLUME_FLOOR_FRAC = 0.01;       // design doc: exclude pairs < 1% of volume
const STALENESS_MAX_MS = 8 * 3_600_000; // design doc: drop points stagnant > 8h

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * The live oracle loop: every 6s wall-clock block, poll the shared feed once,
 * let every validator run its Mini Oracle pipeline, tick the (unchanged)
 * Chain + LatchedMedianAggregator, and record the full per-validator story.
 * Serves the standard chart UI on top of the growing in-memory series.
 */
export async function runLive(opts: LiveRunOptions): Promise<void> {
  const feed = new LiveFeed(opts.venues);

  let currentSnapshot: FeedSnapshot | null = null;
  const source: LiveObservationSource = {
    snapshot: () => {
      if (!currentSnapshot) throw new Error("live: snapshot read before first poll");
      return currentSnapshot;
    },
    pipelineOptions: () => ({
      madK: opts.madK,
      volumeFloorFrac: VOLUME_FLOOR_FRAC,
      stalenessMaxMs: STALENESS_MAX_MS,
      nowMs: Date.now(),
    }),
  };

  // Validators: honest Mini Oracle runners with seeded per-validator rngs and
  // deterministic venue subsets.
  const validators: LiveHonestValidator[] = [];
  for (let i = 0; i < opts.validatorCount; i++) {
    const rng = mulberry32(opts.seed + i + 1);
    const subset = pickVenueSubset(opts.venues, opts.subsetSize, rng);
    validators.push(new LiveHonestValidator(i, subset, source, rng, opts.jitterStdDev));
  }

  // First snapshot — retry until at least one venue serves DOT data.
  console.log(`\nLive mode: polling ${opts.venues.join(", ")} …`);
  let referencePrice = NaN;
  for (let attempt = 0; ; attempt++) {
    currentSnapshot = await feed.poll();
    const venueMap = venueUsdPrices(currentSnapshot.points);
    if (venueMap.size > 0) {
      referencePrice = mean([...venueMap.values()]);
      break;
    }
    if (attempt >= 9) throw new Error("live: no venue served DOT data after 10 attempts");
    console.log("  no venue data yet, retrying in 6s…");
    for (const [v, s] of Object.entries(currentSnapshot.venueStatus)) {
      if (s.lastError) console.log(`    [${v}] ${s.lastError}`);
    }
    await Bun.sleep(6_000);
  }
  console.log(`  first cross-venue reference price: ${referencePrice.toFixed(4)} USD`);

  // The chain reuses the historical-sim machinery verbatim: PriceEndpoint over
  // a growing array (we append one point per tick BEFORE nextBlock reads it).
  const livePoints: PricePoint[] = [];
  const endpoint = new PriceEndpoint(livePoints);
  const chain = new Chain(referencePrice, validators, endpoint, mulberry32(opts.seed), new LatchedMedianAggregator());
  const store = new LiveStore(opts.outputDir, opts.convergenceThreshold, opts.venues);

  const startedAt = new Date();
  const config: SimulationConfig = {
    startDate: startedAt.toISOString().slice(0, 10),
    endDate: startedAt.toISOString().slice(0, 10),
    validators: [{
      type: "honest",
      count: opts.validatorCount,
      priceSource: { kind: "random-venue", jitterStdDev: opts.jitterStdDev },
    }],
    seed: opts.seed,
    convergenceThreshold: opts.convergenceThreshold,
    label: `live | latched-median | ${opts.validatorCount} mini-oracle`,
    aggregator: { kind: "latched-median" },
    realPrice: { kind: "trades", venues: opts.venues, crossVenue: { kind: "mean" } },
  };

  let serverStarted = false;

  const tick = async (): Promise<void> => {
    const snap = await feed.poll();
    currentSnapshot = snap;

    const venueMap = venueUsdPrices(snap.points);
    if (venueMap.size > 0) referencePrice = mean([...venueMap.values()]);

    const timestamp = Math.floor(Date.now() / 1000 / BLOCK_TIME_SECONDS) * BLOCK_TIME_SECONDS;
    livePoints.push({ timestamp, price: referencePrice });

    const prevOraclePrice = chain.lastPrice;
    const m = chain.nextBlock();

    const submissions: LiveSubmissionRecord[] = [];
    const traces = new Map<number, MiniOracleTrace>();
    for (const v of validators) {
      const t = v.lastTrace;
      if (t) traces.set(v.index, t);
      const count = (reason: "stale" | "volume" | "mad") =>
        t ? t.points.filter((p) => p.dropped === reason).length : 0;
      submissions.push({
        validatorIndex: v.index,
        price: v.lastQuote,
        venues: v.venues,
        used: t ? t.points.filter((p) => p.dropped === null).length : 0,
        droppedStale: count("stale"),
        droppedVolume: count("volume"),
        droppedMad: count("mad"),
      });
    }

    const venuePrices: Record<string, number | null> = {};
    for (const v of opts.venues) venuePrices[v] = venueMap.get(v) ?? null;

    const record: LiveBlockRecord = {
      block: m.block,
      timestamp,
      realPrice: m.realPrice,
      oraclePrice: m.oraclePrice,
      prevOraclePrice,
      authorIndex: m.authorIndex,
      priceUpdated: m.priceUpdated,
      medianValidatorIndex: m.medianValidatorIndex ?? null,
      inherentTotal: m.inherentTotal,
      submissions,
      venuePrices,
      venueStatus: snap.venueStatus,
    };
    store.append(record, traces);

    const failing = Object.entries(snap.venueStatus).filter(([, s]) => !s.ok).map(([v]) => v);
    process.stdout.write(
      `\r  block ${m.block.toString().padStart(6)} · real ${m.realPrice.toFixed(4)} · oracle ${m.oraclePrice.toFixed(4)}` +
      ` · dev ${m.deviationPct.toFixed(3)}% · inherent ${m.inherentTotal}/${opts.validatorCount}` +
      (failing.length > 0 ? ` · DOWN: ${failing.join(",")}` : "") + "   ",
    );

    if (!serverStarted) {
      serverStarted = true;
      startLiveServer({
        store,
        config,
        venues: opts.venues,
        validators: validators.map((v) => ({ index: v.index, venues: v.venues })),
        feedStatus: () => (currentSnapshot ? currentSnapshot.venueStatus : {}),
      }, opts.port, opts.openBrowser);
    }
  };

  // Align ticks to the 6s wall-clock grid; recursive timeout avoids drift.
  console.log(`  starting 6s block loop (Ctrl+C to stop). Records → ${opts.outputDir}/live_blocks.jsonl\n`);
  await tick();
  await new Promise<never>(() => {
    const scheduleNext = () => {
      const now = Date.now();
      const next = Math.floor(now / 6_000) * 6_000 + 6_000;
      setTimeout(async () => {
        try {
          await tick();
        } catch (e) {
          console.error(`\n  tick failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        scheduleNext();
      }, next - now);
    };
    scheduleNext();
  });
}

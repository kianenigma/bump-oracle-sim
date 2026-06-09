import { join } from "path";
import type {
  BlockMetrics,
  ScenarioMeta,
  SimulationConfig,
  SimulationSummary,
  VenueId,
} from "../types.js";
import { BLOCK_TIME_SECONDS } from "../config.js";
import { loadVenueBuckets } from "../data/source.js";
import { combineVenues, daysInRange } from "../data/trades/aggregate.js";
import { BLOCKS_PER_DAY, type VenueBucket } from "../data/trades/types.js";
import { ChunkWriter, writeIndex, scenarioDirName } from "../viz/writer.js";

// ─────────────────────────────────────────────────────────────────────────────
// Price-analysis subcommand (no oracle simulation).
//
// For each 6s block we take every venue's *last-trade* price — the closest
// historical analog to a validator reading a live spot ticker — and measure the
// INTER-VENUE SPREAD: (max − min) / reference, where reference ∈ {mean, median,
// vwap}. The numerator is reference-independent, so the three differ only in the
// normaliser (sub-1% price level) — we report all three as a robustness check.
//
// Spread is a *conservative upper bound* on any single venue's error vs the
// mean (|venue − mean| ≤ max − min). So "spread < 0.5% for X% of blocks" proves
// every venue — and therefore any single-venue spot read, and the mean — is
// within 0.5% of consensus for X% of the time. That is the evidence the report
// is after: it bounds the cost of "just use one venue's spot price".
//
// Coinbase is excluded upstream (it has no genuine historical sub-minute trade
// data — our source backfills it from 1m candles, so a 6s "last trade" would be
// synthetic). The caller passes a coinbase-free venue list.
// ─────────────────────────────────────────────────────────────────────────────

type RefKind = "mean" | "median" | "vwap";
const REFS: RefKind[] = ["mean", "median", "vwap"];

interface Band {
  /** Human label. */
  label: string;
  /** Inclusive lower / exclusive upper bound in percent (hi = Infinity last). */
  lo: number;
  hi: number;
}

// Bands from the spec: <0.5, 0.5–1, 1–5, plus a ≥5 catch-all for hygiene.
const BANDS: Band[] = [
  { label: "< 0.5%", lo: 0, hi: 0.5 },
  { label: "0.5–1%", lo: 0.5, hi: 1 },
  { label: "1–5%", lo: 1, hi: 5 },
  { label: "≥ 5%", lo: 5, hi: Infinity },
];
// Bands we collect episode lists for ("for manual inspection").
const EPISODE_BAND_INDICES = [1, 2];
// Stop retaining episodes past this many per (ref, band) — guards memory if the
// data is pathologically choppy. Reported when hit (no silent truncation).
const MAX_EPISODES = 100_000;

// Histogram for percentile estimation of the mean-reference spread. Bins of
// HIST_MAX/HIST_BINS percent, plus one overflow bin.
const HIST_MAX = 20; // percent
const HIST_BINS = 20_000;

function bandIndexOf(spreadPct: number): number {
  for (let b = 0; b < BANDS.length; b++) {
    if (spreadPct >= BANDS[b].lo && spreadPct < BANDS[b].hi) return b;
  }
  return BANDS.length - 1; // ≥ last.lo
}

function median5(sorted: number[]): number {
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface Episode {
  startTimestamp: number;
  endTimestamp: number;
  durationSec: number;
  blocks: number;
  peakSpreadPct: number;
  peakTimestamp: number;
  /** Venues that were the max / min at the peak block. */
  peakHighVenue: VenueId;
  peakLowVenue: VenueId;
}

interface BandStat {
  label: string;
  blocks: number;
  pctTime: number;
  durationSec: number;
}

interface RefReport {
  reference: RefKind;
  meanSpreadPct: number;
  maxSpreadPct: number;
  bands: BandStat[];
  /** Episodes per episode-band, keyed by band label. */
  episodes: Record<string, Episode[]>;
  episodesTruncated: boolean;
}

export interface PriceAnalysisReport {
  venues: VenueId[];
  startDate: string;
  endDate: string;
  totalBlocks: number;
  blockTimeSeconds: number;
  /** Per-venue share of trade-bearing buckets that fell back to VWAP because
   *  the cached bucket predated the last-trade field (0 = all genuine last
   *  trades). */
  lastTradeFallbackPctByVenue: Record<string, number>;
  references: RefReport[];
}

// Per-(ref, band) episode accumulator with an open-run state machine.
class EpisodeTracker {
  episodes: Episode[] = [];
  truncated = false;
  private open: {
    startTs: number;
    startBlock: number;
    lastTs: number;
    blocks: number;
    peakSpread: number;
    peakTs: number;
    peakHigh: VenueId;
    peakLow: VenueId;
  } | null = null;

  step(inBand: boolean, ts: number, spreadPct: number, high: VenueId, low: VenueId): void {
    if (inBand) {
      if (!this.open) {
        this.open = {
          startTs: ts, startBlock: 0, lastTs: ts, blocks: 1,
          peakSpread: spreadPct, peakTs: ts, peakHigh: high, peakLow: low,
        };
      } else {
        this.open.lastTs = ts;
        this.open.blocks++;
        if (spreadPct > this.open.peakSpread) {
          this.open.peakSpread = spreadPct;
          this.open.peakTs = ts;
          this.open.peakHigh = high;
          this.open.peakLow = low;
        }
      }
    } else if (this.open) {
      this.close();
    }
  }

  close(): void {
    if (!this.open) return;
    if (this.episodes.length < MAX_EPISODES) {
      this.episodes.push({
        startTimestamp: this.open.startTs,
        endTimestamp: this.open.lastTs,
        durationSec: this.open.blocks * BLOCK_TIME_SECONDS,
        blocks: this.open.blocks,
        peakSpreadPct: this.open.peakSpread,
        peakTimestamp: this.open.peakTs,
        peakHighVenue: this.open.peakHigh,
        peakLowVenue: this.open.peakLow,
      });
    } else {
      this.truncated = true;
    }
    this.open = null;
  }
}

/**
 * Throw unless every venue has at least one trade in every UTC day of the
 * range. Operates on the RAW per-venue buckets (where empty windows are still
 * null — after combineVenues they'd be carry-forward-filled and invisible).
 */
function assertFullVenueCoverage(perVenue: Map<VenueId, VenueBucket[]>, days: string[]): void {
  const expected = days.length * BLOCKS_PER_DAY;
  for (const [venue, buckets] of perVenue) {
    if (buckets.length !== expected) {
      throw new Error(
        `analyze-price: ${venue} returned ${buckets.length} buckets for ${days.length} day(s), ` +
        `expected ${expected}. Trade data is incomplete — cannot run.`,
      );
    }
    for (let d = 0; d < days.length; d++) {
      const base = d * BLOCKS_PER_DAY;
      let hasData = false;
      for (let i = 0; i < BLOCKS_PER_DAY; i++) {
        if (buckets[base + i].vwap !== null) { hasData = true; break; }
      }
      if (!hasData) {
        throw new Error(
          `analyze-price: ${venue} has NO trade data on ${days[d]}. ` +
          `Every venue must have data for every day in the range — narrow the range ` +
          `(--start-date/--end-date) or drop the venue (--venues). Refusing to analyze partial data.`,
        );
      }
    }
  }
}

export interface PriceAnalysisOptions {
  /** Venue list, already coinbase-excluded by the caller. */
  venues: VenueId[];
  startDate: string;
  endDate: string;
  seed: number;
  outputDir: string;
  /** How many episodes to print per (ref, band) before summarising the rest. */
  episodeStdoutCap?: number;
}

/**
 * Run the whole price-analysis pipeline: load venue buckets, combine on
 * last-trade, compute spread/band/episode stats against all three references,
 * write a servable .simdata (per-venue lines + a spread-vs-mean pseudo-scenario)
 * plus `price_analysis.json`, and print the CLI report.
 */
export async function runPriceAnalysis(opts: PriceAnalysisOptions): Promise<PriceAnalysisReport> {
  const { venues, startDate, endDate, seed, outputDir } = opts;
  const cap = opts.episodeStdoutCap ?? 15;

  console.log(`\n[Price analysis] venues: ${venues.join(", ")} (coinbase excluded)`);
  console.log(`  Range: ${startDate} → ${endDate}; signal: last-trade per 6s block`);

  const perVenue = await loadVenueBuckets(venues, startDate, endDate);

  // Hard requirement: every venue must have trade data for every day in range.
  // A whole UTC day with zero trades on a liquid DOT venue means the dump was
  // unavailable (missing/late-listed/gap), which would distort the spread via
  // carry-forward — so we fail loudly rather than analyze partial data.
  assertFullVenueCoverage(perVenue, daysInRange(startDate, endDate));

  // Honest reporting: how much of each venue's trade-bearing history fell back
  // to VWAP because the cached bucket predated the last-trade field.
  const fallbackPct: Record<string, number> = {};
  for (const v of venues) {
    const buckets = perVenue.get(v) ?? [];
    let withTrades = 0;
    let fellBack = 0;
    for (const b of buckets) {
      if (b.vwap !== null) {
        withTrades++;
        if (b.lastTrade === undefined) fellBack++;
      }
    }
    fallbackPct[v] = withTrades > 0 ? (fellBack / withTrades) * 100 : 0;
  }

  // Combine on last-trade. `points` is the cross-venue MEAN series (our primary
  // reference and the chart's real-price line); per-venue arrays are aligned.
  const combined = combineVenues(perVenue, { kind: "mean" }, "lastTrade");
  const points = combined.points;
  const N = points.length;
  if (N === 0) throw new Error("price-analysis: no overlapping venue data in range");

  const venueIds = [...combined.venuePrices.keys()];
  const venuePriceArr = venueIds.map((v) => combined.venuePrices.get(v)!);
  const venueVolArr = venueIds.map((v) => combined.venueVolumes.get(v)!);

  // Per-reference accumulators.
  const bandCounts: number[][] = REFS.map(() => new Array(BANDS.length).fill(0));
  const spreadSum: number[] = REFS.map(() => 0);
  const spreadMax: number[] = REFS.map(() => 0);
  const trackers: Record<number, EpisodeTracker>[] = REFS.map(() => {
    const m: Record<number, EpisodeTracker> = {};
    for (const bi of EPISODE_BAND_INDICES) m[bi] = new EpisodeTracker();
    return m;
  });

  // Mean-reference histogram for p95/p99 + max-consecutive-above-0.5% streak.
  const hist = new Int32Array(HIST_BINS + 1);
  let maxConsecAbove = 0;
  let curConsecAbove = 0;

  // Pseudo-scenario writer: realPrice/oracle = mean ref, deviation = spread-vs-mean.
  const label = "venue spread (last-trade) vs mean";
  const dirName = scenarioDirName(label, 0);
  const writer = new ChunkWriter(join(outputDir, dirName));

  const sortedScratch = new Array<number>(venueIds.length);

  for (let i = 0; i < N; i++) {
    const ts = points[i].timestamp;
    // Gather this block's per-venue prices/volumes.
    let max = -Infinity, min = Infinity, sum = 0;
    let argHigh = 0, argLow = 0;
    let vwNum = 0, vwDen = 0;
    for (let k = 0; k < venueIds.length; k++) {
      const p = venuePriceArr[k][i];
      sortedScratch[k] = p;
      sum += p;
      if (p > max) { max = p; argHigh = k; }
      if (p < min) { min = p; argLow = k; }
      const vol = venueVolArr[k][i];
      if (vol > 0) { vwNum += p * vol; vwDen += vol; }
    }
    const gap = max - min;
    const meanRef = sum / venueIds.length;
    sortedScratch.sort((a, b) => a - b);
    const medianRef = median5(sortedScratch);
    const vwapRef = vwDen > 0 ? vwNum / vwDen : meanRef;
    const refVal: Record<RefKind, number> = { mean: meanRef, median: medianRef, vwap: vwapRef };

    const highVenue = venueIds[argHigh];
    const lowVenue = venueIds[argLow];

    for (let r = 0; r < REFS.length; r++) {
      const ref = refVal[REFS[r]];
      const spread = ref > 0 ? (gap / ref) * 100 : 0;
      const bi = bandIndexOf(spread);
      bandCounts[r][bi]++;
      spreadSum[r] += spread;
      if (spread > spreadMax[r]) spreadMax[r] = spread;
      for (const ebi of EPISODE_BAND_INDICES) {
        trackers[r][ebi].step(bi === ebi, ts, spread, highVenue, lowVenue);
      }
    }

    // Mean-reference spread drives the chart + summary histogram.
    const meanSpread = meanRef > 0 ? (gap / meanRef) * 100 : 0;
    const hb = meanSpread >= HIST_MAX ? HIST_BINS : Math.floor((meanSpread / HIST_MAX) * HIST_BINS);
    hist[hb]++;
    if (meanSpread >= 0.5) { curConsecAbove++; if (curConsecAbove > maxConsecAbove) maxConsecAbove = curConsecAbove; }
    else curConsecAbove = 0;

    const m: BlockMetrics = {
      block: i,
      timestamp: ts,
      realPrice: meanRef,
      oraclePrice: meanRef,
      authorIndex: 0,
      authorIsHonest: true,
      authorType: "honest",
      totalBumps: 0,
      activatedBumps: 0,
      netDirection: 0,
      inherentTotal: 0,
      inherentNonHonest: 0,
      inherentNonHonestPct: 0,
      priceUpdated: true,
      deviation: gap,
      deviationPct: meanSpread,
    };
    writer.addBlock(m);
  }

  // Close any episodes still open at the end of the series.
  for (let r = 0; r < REFS.length; r++) {
    for (const ebi of EPISODE_BAND_INDICES) trackers[r][ebi].close();
  }

  const info = writer.finish();

  // ── Build the structured report ──
  const percentile = (p: number): number => {
    const target = p * N;
    let cum = 0;
    for (let b = 0; b <= HIST_BINS; b++) {
      cum += hist[b];
      if (cum >= target) {
        return b >= HIST_BINS ? HIST_MAX : ((b + 0.5) * HIST_MAX) / HIST_BINS;
      }
    }
    return HIST_MAX;
  };

  const references: RefReport[] = REFS.map((ref, r) => {
    const bands: BandStat[] = BANDS.map((band, bi) => ({
      label: band.label,
      blocks: bandCounts[r][bi],
      pctTime: (bandCounts[r][bi] / N) * 100,
      durationSec: bandCounts[r][bi] * BLOCK_TIME_SECONDS,
    }));
    const episodes: Record<string, Episode[]> = {};
    let truncated = false;
    for (const ebi of EPISODE_BAND_INDICES) {
      const tr = trackers[r][ebi];
      episodes[BANDS[ebi].label] = tr.episodes;
      truncated = truncated || tr.truncated;
    }
    return {
      reference: ref,
      meanSpreadPct: spreadSum[r] / N,
      maxSpreadPct: spreadMax[r],
      bands,
      episodes,
      episodesTruncated: truncated,
    };
  });

  const report: PriceAnalysisReport = {
    venues,
    startDate,
    endDate,
    totalBlocks: N,
    blockTimeSeconds: BLOCK_TIME_SECONDS,
    lastTradeFallbackPctByVenue: fallbackPct,
    references,
  };

  // ── Write servable .simdata: venues.json + index.json (pseudo-scenario) ──
  const meanReport = references[0];
  const config: SimulationConfig = {
    startDate,
    endDate,
    validators: [],
    seed,
    convergenceThreshold: 0.5,
    label,
    realPrice: { kind: "trades", venues, crossVenue: { kind: "mean" } },
  };
  const summary: SimulationSummary = {
    totalBlocks: N,
    aggregator: "median", // placeholder — no oracle here
    epsilon: 0,
    epsilonMode: "abs",
    convergenceThreshold: 0.5,
    convergenceRate: meanReport.bands[0].pctTime, // % of time spread < 0.5%
    meanDeviation: 0,
    meanDeviationPct: meanReport.meanSpreadPct,
    maxDeviation: 0,
    maxDeviationPct: meanReport.maxSpreadPct,
    deviationIntegral: spreadSum[0],
    maxDeviationRate: 0,
    maxConsecutiveBlocksAboveThreshold: maxConsecAbove,
    p95DeviationPct: percentile(0.95),
    p99DeviationPct: percentile(0.99),
  };
  const meta: ScenarioMeta = {
    config,
    summary,
    blockCount: info.blockCount,
    chunkCount: info.chunkCount,
    timeRange: info.timeRange,
    chunkTimeRanges: info.chunkTimeRanges,
    dir: dirName,
  };

  // Per-venue last-trade lines + volumes → venues.json (via writeIndex). We feed
  // a ResolvedPriceSource-shaped object; `points` is the mean series so the
  // chart's real-price line is the cross-venue mean.
  const venuePricesRec = Object.fromEntries(venueIds.map((v) => [v, combined.venuePrices.get(v)!])) as Record<VenueId, number[]>;
  const venueVolumesRec = Object.fromEntries(venueIds.map((v) => [v, combined.venueVolumes.get(v)!])) as Record<VenueId, number[]>;
  writeIndex(outputDir, [meta], {
    pricePoints: points,
    venuePrices: venuePricesRec,
    venueVolumes: venueVolumesRec,
  });

  await Bun.write(join(outputDir, "price_analysis.json"), JSON.stringify(report, null, 2));

  printReport(report, cap);
  return report;
}

// ── CLI report ───────────────────────────────────────────────────────────────

function fmtPct(x: number): string {
  return `${x.toFixed(4)}%`;
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = sec / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function fmtTs(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function printReport(report: PriceAnalysisReport, cap: number): void {
  const totalSec = report.totalBlocks * report.blockTimeSeconds;
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`  PRICE ANALYSIS — inter-venue spread (last-trade per 6s)`);
  console.log(`  ${report.venues.join(", ")}  |  ${report.startDate} → ${report.endDate}`);
  console.log(`  ${report.totalBlocks.toLocaleString()} blocks (${fmtDuration(totalSec)} of history)`);
  console.log(`══════════════════════════════════════════════════════════════════════`);

  // Last-trade fidelity note.
  const anyFallback = Object.values(report.lastTradeFallbackPctByVenue).some((p) => p > 0.01);
  if (anyFallback) {
    const parts = report.venues
      .map((v) => `${v} ${report.lastTradeFallbackPctByVenue[v].toFixed(1)}%`)
      .join(", ");
    console.log(`\n  Note: some buckets fell back to 6s-VWAP (cached before last-trade existed):`);
    console.log(`        ${parts}`);
    console.log(`        (within a 6s window VWAP ≈ last-trade; negligible for cross-venue spread)`);
  }

  for (const ref of report.references) {
    console.log(`\n  ── reference = ${ref.reference.toUpperCase()}  (spread = (max−min) / ${ref.reference}) ──`);
    console.log(`     mean spread ${fmtPct(ref.meanSpreadPct)}   max spread ${fmtPct(ref.maxSpreadPct)}`);
    console.log(`     ${"band".padEnd(10)} ${"% of time".padStart(11)} ${"duration".padStart(12)} ${"blocks".padStart(14)}`);
    for (const b of ref.bands) {
      console.log(
        `     ${b.label.padEnd(10)} ${b.pctTime.toFixed(4).padStart(10)}% ` +
        `${fmtDuration(b.durationSec).padStart(12)} ${b.blocks.toLocaleString().padStart(14)}`,
      );
    }
  }

  // Episode detail: print for the MEAN reference (representative — the three
  // references share the (max−min) numerator and so produce near-identical
  // episodes). The full set for all three is in price_analysis.json.
  const mean = report.references[0];
  console.log(`\n  ── elevated-spread occurrences (reference = mean; full lists in price_analysis.json) ──`);
  for (const bandLabel of Object.keys(mean.episodes)) {
    const eps = mean.episodes[bandLabel];
    const sorted = [...eps].sort((a, b) => b.peakSpreadPct - a.peakSpreadPct);
    console.log(`\n     band ${bandLabel}: ${eps.length.toLocaleString()} episode(s)` +
      (mean.episodesTruncated ? ` (truncated at ${MAX_EPISODES.toLocaleString()})` : ""));
    if (eps.length === 0) continue;
    console.log(`       ${"start (UTC)".padEnd(21)} ${"duration".padStart(9)} ${"peak".padStart(9)}  high→low`);
    for (const e of sorted.slice(0, cap)) {
      console.log(
        `       ${fmtTs(e.startTimestamp).padEnd(21)} ${fmtDuration(e.durationSec).padStart(9)} ` +
        `${e.peakSpreadPct.toFixed(3).padStart(8)}%  ${e.peakHighVenue}→${e.peakLowVenue}`,
      );
    }
    if (sorted.length > cap) console.log(`       … and ${(sorted.length - cap).toLocaleString()} more (see JSON), shown top ${cap} by peak`);
  }
  console.log("");
}

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { MiniOracleTrace } from "./types.js";
import type { LiveBlockRecord } from "./types.js";

/** How many recent blocks keep their FULL per-validator pipeline traces in
 *  memory (each trace is ~20 points × N validators — too heavy to keep for
 *  every block of a multi-day run). Slim records are kept for ALL blocks. */
const TRACE_RING_BLOCKS = 3_000;

/**
 * In-memory store for a live run + JSONL persistence.
 *
 * Columnar arrays mirror what a .simdata chunk carries so the existing
 * aggregation helpers (viz/aggregation.ts) work on them directly; slim
 * per-block records carry every validator's submission for the block-detail
 * page; a bounded ring keeps full Mini Oracle traces for recent blocks.
 */
export class LiveStore {
  // Columnar series (grow one entry per block).
  readonly timestamps: number[] = [];
  readonly realPrices: number[] = [];
  readonly oraclePrices: number[] = [];
  readonly deviationPcts: number[] = [];
  /** Per-venue representative USD price series (carry-forward-filled). */
  readonly venueSeries: Record<string, number[]> = {};

  /** Slim per-block records, index == block number. */
  readonly records: LiveBlockRecord[] = [];

  private traceRing = new Map<number, Map<number, MiniOracleTrace>>();
  private jsonlPath: string;

  // Running summary stats.
  private sumDev = 0;
  private sumDevPct = 0;
  private maxDev = 0;
  private maxDevPct = 0;
  private converged = 0;

  constructor(outputDir: string, private convergenceThreshold: number, venues: string[]) {
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    this.jsonlPath = join(outputDir, "live_blocks.jsonl");
    for (const v of venues) this.venueSeries[v] = [];
  }

  get blockCount(): number {
    return this.records.length;
  }

  append(record: LiveBlockRecord, traces: Map<number, MiniOracleTrace>): void {
    this.timestamps.push(record.timestamp);
    this.realPrices.push(record.realPrice);
    this.oraclePrices.push(record.oraclePrice);
    const devPct = record.realPrice !== 0
      ? (Math.abs(record.realPrice - record.oraclePrice) / record.realPrice) * 100
      : 0;
    this.deviationPcts.push(devPct);

    for (const [venue, series] of Object.entries(this.venueSeries)) {
      const p = record.venuePrices[venue];
      // Carry forward on venue outage; seed with the cross-venue real price.
      const prev = series.length > 0 ? series[series.length - 1] : record.realPrice;
      series.push(p ?? prev);
    }

    this.records.push(record);
    this.traceRing.set(record.block, traces);
    if (this.traceRing.size > TRACE_RING_BLOCKS) {
      const oldest = this.traceRing.keys().next().value;
      if (oldest !== undefined) this.traceRing.delete(oldest);
    }

    // Running stats.
    const dev = Math.abs(record.realPrice - record.oraclePrice);
    this.sumDev += dev;
    this.sumDevPct += devPct;
    if (dev > this.maxDev) this.maxDev = dev;
    if (devPct > this.maxDevPct) this.maxDevPct = devPct;
    if (devPct < this.convergenceThreshold) this.converged++;

    appendFileSync(this.jsonlPath, JSON.stringify(record) + "\n");
  }

  tracesFor(block: number): Map<number, MiniOracleTrace> | undefined {
    return this.traceRing.get(block);
  }

  recordAt(block: number): LiveBlockRecord | undefined {
    return this.records[block];
  }

  /** Resolve a block index from a chart timestamp (uniform 6s spacing). */
  blockAtTimestamp(ts: number): number {
    if (this.records.length === 0) return 0;
    const t0 = this.timestamps[0];
    const idx = Math.floor((ts - t0) / 6);
    return Math.max(0, Math.min(this.records.length - 1, idx));
  }

  summaryStats(): {
    meanDeviation: number; meanDeviationPct: number;
    maxDeviation: number; maxDeviationPct: number;
    convergenceRate: number; p95DeviationPct: number; p99DeviationPct: number;
  } {
    const n = Math.max(1, this.records.length);
    const sorted = this.deviationPcts.slice().sort((a, b) => a - b);
    const pct = (p: number) => sorted.length === 0
      ? 0
      : sorted[Math.min(Math.floor(p * sorted.length), sorted.length - 1)];
    return {
      meanDeviation: this.sumDev / n,
      meanDeviationPct: this.sumDevPct / n,
      maxDeviation: this.maxDev,
      maxDeviationPct: this.maxDevPct,
      convergenceRate: this.converged / n,
      p95DeviationPct: pct(0.95),
      p99DeviationPct: pct(0.99),
    };
  }
}

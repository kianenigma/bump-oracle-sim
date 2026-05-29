import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import type { BlockMetrics, SimulationConfig, SimulationSummary, SimDataIndex, ScenarioMeta, BlockChunk, ResolvedPriceSource, VenueId } from "../types.js";
import { BLOCKS_PER_CHUNK } from "../types.js";
import { BLOCK_TIME_SECONDS } from "../config.js";
import type { BlockSink } from "../sim/engine.js";

/**
 * Streams block data to chunked JSON files in a scenario subdirectory.
 * Each chunk file is ≤ ~50MB (1M blocks × ~48 bytes columnar JSON).
 */
export class ChunkWriter {
  private dir: string;
  private chunkIndex = 0;
  private blockOffset = 0;
  private totalBlocks = 0;
  private timestamps: number[] = [];
  private realPrices: number[] = [];
  private oraclePrices: number[] = [];
  private deviationPcts: number[] = [];
  private priceUpdated: number[] = [];
  private inherentTotals: number[] = [];
  private medianValidatorIndices: number[] = [];
  /** Per-block arrays for nudge-aggregator diagnostics. Allocated lazily on
   *  the first block that carries each field — see `tracksAgreementRate` /
   *  `tracksEpsilonCoefficient`. Both arrays are written to the chunk only
   *  when the corresponding tracking flag is true. */
  private agreementRates: number[] = [];
  private epsilonCoefficients: number[] = [];
  /** Set on the FIRST block of the run and never reset. The aggregator type
   *  (and velocity presence) is fixed for the lifetime of a scenario, so we
   *  decide once whether to persist these per-block arrays. Avoids writing
   *  meaningless `-1`-filled arrays for median or velocity-less runs. */
  private tracksAgreementRate?: boolean;
  private tracksEpsilonCoefficient?: boolean;
  private firstTimestamp = 0;
  private lastTimestamp = 0;
  private chunkTimeRanges: Array<{ from: number; to: number }> = [];

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.dir = dir;
  }

  get sink(): BlockSink {
    return (m: BlockMetrics) => this.addBlock(m);
  }

  addBlock(m: BlockMetrics): void {
    if (this.totalBlocks === 0) {
      this.firstTimestamp = m.timestamp;
      // Lock the tracking decision on the first block. Median emits neither
      // field. Nudge always emits agreementRate (except on freeze blocks
      // with empty inherent — those use -1 sentinel). Nudge emits
      // epsilonCoefficient only when a velocity schedule is configured.
      this.tracksAgreementRate = m.agreementRate !== undefined;
      this.tracksEpsilonCoefficient = m.epsilonCoefficient !== undefined;
    }
    this.lastTimestamp = m.timestamp;

    this.timestamps.push(m.timestamp);
    this.realPrices.push(m.realPrice);
    this.oraclePrices.push(m.oraclePrice);
    this.deviationPcts.push(m.deviationPct);
    this.priceUpdated.push(m.priceUpdated ? 1 : 0);
    this.inherentTotals.push(m.inherentTotal);
    this.medianValidatorIndices.push(m.medianValidatorIndex ?? -1);
    if (this.tracksAgreementRate) this.agreementRates.push(m.agreementRate ?? -1);
    if (this.tracksEpsilonCoefficient) this.epsilonCoefficients.push(m.epsilonCoefficient ?? -1);
    this.totalBlocks++;

    if (this.timestamps.length >= BLOCKS_PER_CHUNK) {
      this.flushChunk();
    }
  }

  finish(): { blockCount: number; chunkCount: number; timeRange: { from: number; to: number }; chunkTimeRanges: Array<{ from: number; to: number }> } {
    if (this.timestamps.length > 0) {
      this.flushChunk();
    }
    return {
      blockCount: this.totalBlocks,
      chunkCount: this.chunkIndex,
      timeRange: { from: this.firstTimestamp, to: this.lastTimestamp },
      chunkTimeRanges: this.chunkTimeRanges,
    };
  }

  private flushChunk(): void {
    const chunk: BlockChunk = {
      chunkIndex: this.chunkIndex,
      blockOffset: this.blockOffset,
      blockCount: this.timestamps.length,
      timestamps: this.timestamps,
      realPrices: this.realPrices,
      oraclePrices: this.oraclePrices,
      deviationPcts: this.deviationPcts,
      priceUpdated: this.priceUpdated,
      inherentTotals: this.inherentTotals,
      medianValidatorIndices: this.medianValidatorIndices,
    };
    if (this.tracksAgreementRate) chunk.agreementRates = this.agreementRates;
    if (this.tracksEpsilonCoefficient) chunk.epsilonCoefficients = this.epsilonCoefficients;

    this.chunkTimeRanges.push({
      from: this.timestamps[0],
      to: this.timestamps[this.timestamps.length - 1],
    });

    const path = join(this.dir, `blocks_${this.chunkIndex}.json`);
    writeChunkStreaming(path, chunk);

    this.blockOffset += this.timestamps.length;
    this.chunkIndex++;
    this.timestamps = [];
    this.realPrices = [];
    this.oraclePrices = [];
    this.deviationPcts = [];
    this.priceUpdated = [];
    this.inherentTotals = [];
    this.medianValidatorIndices = [];
    this.agreementRates = [];
    this.epsilonCoefficients = [];
  }
}

/** Stream-write a chunk file to avoid building a single giant JSON string. */
function writeChunkStreaming(path: string, chunk: BlockChunk): void {
  Bun.write(path, ""); // truncate
  const writer = Bun.file(path).writer();

  writer.write(`{"chunkIndex":${chunk.chunkIndex},"blockOffset":${chunk.blockOffset},"blockCount":${chunk.blockCount},`);

  const arrays: [string, number[]][] = [
    ["timestamps", chunk.timestamps],
    ["realPrices", chunk.realPrices],
    ["oraclePrices", chunk.oraclePrices],
    ["deviationPcts", chunk.deviationPcts],
  ];
  if (chunk.priceUpdated) arrays.push(["priceUpdated", chunk.priceUpdated]);
  if (chunk.inherentTotals) arrays.push(["inherentTotals", chunk.inherentTotals]);
  if (chunk.medianValidatorIndices) arrays.push(["medianValidatorIndices", chunk.medianValidatorIndices]);
  if (chunk.agreementRates) arrays.push(["agreementRates", chunk.agreementRates]);
  if (chunk.epsilonCoefficients) arrays.push(["epsilonCoefficients", chunk.epsilonCoefficients]);

  for (let a = 0; a < arrays.length; a++) {
    const [name, arr] = arrays[a];
    writer.write(`"${name}":[`);
    for (let i = 0; i < arr.length; i++) {
      if (i > 0) writer.write(",");
      writer.write(String(arr[i]));
    }
    writer.write("]");
    if (a < arrays.length - 1) writer.write(",");
  }

  writer.write("}");
  writer.end();
}

/**
 * Write the top-level index.json for a simulation output directory.
 *
 * If `priceSource` is provided and contains per-venue prices, also emit
 * `venues.json` at the .simdata root. The server uses this to render
 * per-venue lines on the chart in random-venue mode. Per-venue prices are
 * shared across all scenarios in this .simdata (they came from the same
 * data source / time range), so we only store them once.
 */
export function writeIndex(
  outputDir: string,
  scenarios: ScenarioMeta[],
  priceSource?: ResolvedPriceSource,
): void {
  const index: SimDataIndex = {
    scenarioCount: scenarios.length,
    scenarios,
  };
  Bun.write(join(outputDir, "index.json"), JSON.stringify(index, null, 2));

  if (priceSource?.venuePrices) {
    const timestamps = priceSource.pricePoints.map((p) => p.timestamp);
    const payload: VenuesFile = {
      timestamps,
      venues: priceSource.venuePrices,
    };
    // Volumes are optional — synthetic mode doesn't produce them, and older
    // .simdata dirs predate this field. Readers default to "no volumes" when
    // the key is absent.
    if (priceSource.venueVolumes) payload.volumes = priceSource.venueVolumes;
    Bun.write(join(outputDir, "venues.json"), JSON.stringify(payload));
  }

  // Synthetic-only: persist the per-event span list so the chart can label
  // each hovered block with the event it belongs to. Same lifetime rule as
  // venues.json — emitted alongside the .simdata directory.
  if (priceSource?.events && priceSource.events.length > 0) {
    const payload: EventsFile = {
      firstBlockTimestamp: priceSource.pricePoints[0]?.timestamp ?? 0,
      blockTimeSeconds: BLOCK_TIME_SECONDS,
      events: priceSource.events,
    };
    Bun.write(join(outputDir, "events.json"), JSON.stringify(payload));
  }
}

/** Shape of `events.json`. The block-time + first-block-timestamp pair lets
 *  the server map (timestamp → block index) without loading any chunk. */
export interface EventsFile {
  firstBlockTimestamp: number;
  blockTimeSeconds: number;
  events: import("../types.js").SyntheticEventSpanLite[];
}

/** Load events.json if present (synthetic-mode .simdata only). */
export async function loadEvents(outputDir: string): Promise<EventsFile | null> {
  const path = join(outputDir, "events.json");
  if (!existsSync(path)) return null;
  return Bun.file(path).json();
}

/** Shape of `venues.json` (alongside index.json in a .simdata directory).
 *  `volumes` is optional for backward compat with older .simdata dirs that
 *  predate per-venue volume tracking; readers fall back to "no volumes". */
export interface VenuesFile {
  timestamps: number[];
  venues: Record<VenueId, number[]>;
  volumes?: Record<VenueId, number[]>;
}

/** Load venues.json if present. Returns null when not in trades mode. */
export async function loadVenues(outputDir: string): Promise<VenuesFile | null> {
  const path = join(outputDir, "venues.json");
  if (!existsSync(path)) return null;
  return Bun.file(path).json();
}

/**
 * Load an index.json from a simulation output directory.
 */
export async function loadIndex(outputDir: string): Promise<SimDataIndex> {
  const indexPath = join(outputDir, "index.json");
  if (!existsSync(indexPath)) {
    throw new Error(`No index.json found in ${outputDir}`);
  }
  return Bun.file(indexPath).json();
}

export async function loadChunk(outputDir: string, scenarioDir: string, chunkIndex: number): Promise<BlockChunk> {
  const path = join(outputDir, scenarioDir, `blocks_${chunkIndex}.json`);
  return Bun.file(path).json();
}

/**
 * Streams a per-block CSV with the columns requested by the analyst:
 *   block, timestamp, authorIndex, authorType, maliciousInherentPct,
 *   oraclePrice, realPrice.
 *
 * One file per validator-mix run, written at the .simdata root so all
 * scenarios in a batch sit side-by-side.
 */
export class CsvWriter {
  private writer: ReturnType<ReturnType<typeof Bun.file>["writer"]>;

  constructor(path: string) {
    Bun.write(path, ""); // truncate
    this.writer = Bun.file(path).writer();
    this.writer.write(
      "block,timestamp,authorIndex,authorType,inherentTotal,inherentNonHonest,inherentNonHonestPct,priceUpdated," +
      "oraclePrice,realPrice,priceDiff,medianValidatorType,inherentVotes\n",
    );
  }

  get sink(): BlockSink {
    return (m: BlockMetrics) => {
      // Signed diff: oracle - real. Positive = oracle is above real.
      const diff = m.oraclePrice - m.realPrice;
      // medianValidatorType is only set when the aggregator is median-mode AND
      // priceUpdated; nudge mode and freeze blocks emit "-".
      const medType = m.medianValidatorType ?? "-";
      // inherentVotes is populated for both aggregator modes. Median entries
      // format as `(type, price)`; nudge entries as `(type, +1)` or `(type, -1)`.
      // Empty bracket `[]` when the inherent had no submissions (e.g. a noop
      // author dropped everything).
      let votes = "[]";
      if (m.inherentVotes && m.inherentVotes.length > 0) {
        const parts = m.inherentVotes.map(v =>
          v.kind === "quote"
            ? `(${v.type}, ${v.price})`
            : `(${v.type}, ${v.bump > 0 ? "+1" : "-1"})`,
        );
        votes = `[${parts.join("; ")}]`;
      }
      // Wrap inherentVotes in double-quotes (escaping any internal quotes) so
      // the comma-rich payload doesn't shred the CSV row.
      const votesQuoted = `"${votes.replace(/"/g, '""')}"`;
      this.writer.write(
        `${m.block},${m.timestamp},${m.authorIndex},${m.authorType},` +
        `${m.inherentTotal},${m.inherentNonHonest},${m.inherentNonHonestPct.toFixed(4)},` +
        `${m.priceUpdated ? 1 : 0},` +
        `${m.oraclePrice},${m.realPrice},${diff},` +
        `${medType},${votesQuoted}\n`,
      );
    };
  }

  finish(): void {
    this.writer.end();
  }
}

/** Compose multiple BlockSinks into one. Order of invocation is left-to-right. */
export function combineSinks(...sinks: (BlockSink | undefined)[]): BlockSink | undefined {
  const active = sinks.filter((s): s is BlockSink => s !== undefined);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return (m: BlockMetrics) => { for (const s of active) s(m); };
}

export function scenarioDirName(label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return slug ? `${slug}_${index}` : `scenario_${index}`;
}

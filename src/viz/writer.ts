import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import type { BlockMetrics, SimulationConfig, SimulationSummary, SimDataIndex, ScenarioMeta, BlockChunk, ResolvedPriceSource, VenueId } from "../types.js";
import { BLOCKS_PER_CHUNK } from "../types.js";
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
  // Sparse: only populated on blocks where m.confidenceSnapshot was attached.
  private confTicks: number[] = [];
  private confSamples: number[][] = [];
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
    if (this.totalBlocks === 0) this.firstTimestamp = m.timestamp;
    this.lastTimestamp = m.timestamp;

    const tickInChunk = this.timestamps.length;
    this.timestamps.push(m.timestamp);
    this.realPrices.push(m.realPrice);
    this.oraclePrices.push(m.oraclePrice);
    this.deviationPcts.push(m.deviationPct);
    if (m.confidenceSnapshot) {
      this.confTicks.push(tickInChunk);
      // Convert Float32Array to plain number[] for JSON.
      this.confSamples.push(Array.from(m.confidenceSnapshot));
    }
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
    };
    if (this.confTicks.length > 0) {
      chunk.confidenceSamples = { ticks: this.confTicks, samples: this.confSamples };
    }

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
    this.confTicks = [];
    this.confSamples = [];
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

  if (chunk.confidenceSamples) {
    writer.write(`,"confidenceSamples":{"ticks":[`);
    const ticks = chunk.confidenceSamples.ticks;
    for (let i = 0; i < ticks.length; i++) {
      if (i > 0) writer.write(",");
      writer.write(String(ticks[i]));
    }
    writer.write(`],"samples":[`);
    const samples = chunk.confidenceSamples.samples;
    for (let i = 0; i < samples.length; i++) {
      if (i > 0) writer.write(",");
      writer.write("[");
      const row = samples[i];
      for (let j = 0; j < row.length; j++) {
        if (j > 0) writer.write(",");
        // Cap precision: 4 decimals is plenty for visualisation.
        writer.write(row[j].toFixed(4));
      }
      writer.write("]");
    }
    writer.write("]}");
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
    Bun.write(join(outputDir, "venues.json"), JSON.stringify(payload));
  }
}

/** Shape of `venues.json` (alongside index.json in a .simdata directory). */
export interface VenuesFile {
  timestamps: number[];
  venues: Record<VenueId, number[]>;
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
      "block,timestamp,authorIndex,authorType,inherentTotal,inherentNonHonest,inherentNonHonestPct,priceUpdated,oraclePrice,realPrice,priceDiff\n",
    );
  }

  get sink(): BlockSink {
    return (m: BlockMetrics) => {
      // Signed diff: oracle - real. Positive = oracle is above real.
      const diff = m.oraclePrice - m.realPrice;
      this.writer.write(
        `${m.block},${m.timestamp},${m.authorIndex},${m.authorType},` +
        `${m.inherentTotal},${m.inherentNonHonest},${m.inherentNonHonestPct.toFixed(4)},` +
        `${m.priceUpdated ? 1 : 0},` +
        `${m.oraclePrice},${m.realPrice},${diff}\n`,
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

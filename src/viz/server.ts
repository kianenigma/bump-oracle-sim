import { join } from "path";
import { existsSync } from "fs";
import type {
  SimDataIndex,
  ScenarioMeta,
  BlockChunk,
  ApiMetaResponse,
  ApiDataResponse,
  ValidatorGroup,
  ValidatorType,
  LinePoint,
} from "../types.js";
import { BLOCKS_PER_CHUNK } from "../types.js";
import { aggregateOHLC, aggregateLine, aggregateDeviation, aggregateVolume } from "./aggregation.js";
import { loadIndex, loadChunk, loadVenues, loadEvents, type VenuesFile, type EventsFile } from "./writer.js";
import { mulberry32 } from "../rng.js";
import { BLOCK_TIME_SECONDS } from "../config.js";

const TEMPLATE_PATH = join(import.meta.dir, "template.html");
const BLOCK_TEMPLATE_PATH = join(import.meta.dir, "block.html");
const MAX_CANDLES = 10_000;
const OVER_FETCH_RATIO = 0.1;
const CHUNK_CACHE_MAX = 60;

const TIMEFRAMES = [6, 60, 900, 3600, 21600, 43200, 86400, 604800];

function nextTF(tf: number): number {
  for (const t of TIMEFRAMES) {
    if (t > tf) return t;
  }
  return TIMEFRAMES[TIMEFRAMES.length - 1];
}

// ── LRU chunk cache ──

const chunkCache = new Map<string, BlockChunk>();

async function loadChunkCached(outputDir: string, scenarioDir: string, chunkIndex: number): Promise<BlockChunk> {
  const key = `${scenarioDir}:${chunkIndex}`;
  const cached = chunkCache.get(key);
  if (cached) {
    chunkCache.delete(key);
    chunkCache.set(key, cached);
    return cached;
  }
  const chunk = await loadChunk(outputDir, scenarioDir, chunkIndex);
  chunkCache.set(key, chunk);
  if (chunkCache.size > CHUNK_CACHE_MAX) {
    const firstKey = chunkCache.keys().next().value;
    if (firstKey !== undefined) chunkCache.delete(firstKey);
  }
  return chunk;
}

// ── Helpers ──

function scenarioDir(meta: ScenarioMeta, index: number): string {
  return meta.dir ?? `scenario_${index}`;
}

// ── Author replay (per-scenario cache) ──────────────────────────────────────
// Author selection in chain.ts is `Math.floor(rng() * validators.length)`,
// where the chain's only RNG consumer is author selection. So we can rebuild
// the entire authorIndex sequence by replaying mulberry32(seed) blockCount
// times — no need to write authors to .simdata.
//
// Cache key: scenario directory name (unique per scenario in the index).
// Memory: 4 bytes × blockCount per scenario; 5M blocks ≈ 20 MB. The cache is
// uncapped because `--data` only ever serves one .simdata directory at a time.
const authorCache = new Map<string, Uint32Array>();

function totalValidatorCount(validators: ValidatorGroup[]): number {
  let n = 0;
  for (const g of validators) n += g.count;
  return n;
}

function getAuthorIndices(meta: ScenarioMeta, scenarioIdx: number): Uint32Array {
  const key = scenarioDir(meta, scenarioIdx);
  const cached = authorCache.get(key);
  if (cached) return cached;
  const total = totalValidatorCount(meta.config.validators);
  const arr = new Uint32Array(meta.blockCount);
  if (total > 0) {
    const rng = mulberry32(meta.config.seed);
    for (let i = 0; i < meta.blockCount; i++) {
      arr[i] = Math.floor(rng() * total);
    }
  }
  authorCache.set(key, arr);
  return arr;
}

/** Walk the validator groups (which are stored in order) to find the type
 *  that owns `authorIdx`. O(groups), groups is tiny (<10 typical). */
function validatorTypeAt(validators: ValidatorGroup[], authorIdx: number): ValidatorType {
  let cum = 0;
  for (const g of validators) {
    if (authorIdx < cum + g.count) return g.type;
    cum += g.count;
  }
  // Fallback for out-of-range; shouldn't happen unless authorIdx ≥ total.
  return validators.length > 0 ? validators[validators.length - 1].type : "honest";
}

/** Find which synthetic event covers the given block index (full span runs
 *  from `moveStartBlock` to `postEndBlock` inclusive). Returns null when the
 *  block falls into inter-event filler or precedes the first event. Linear
 *  scan; events arrays are tiny (24-72 entries typically). The returned
 *  shape mirrors the on-disk EventsFile entry plus a derived `phase` tag
 *  describing which sub-phase of the event the hovered block is in. */
function findEventForBlock(
  evf: EventsFile,
  block: number,
): (EventsFile["events"][number] & { phase: "move" | "hold" | "recovery" | "post" }) | null {
  for (const ev of evf.events) {
    if (block < ev.moveStartBlock || block > ev.postEndBlock) continue;
    let phase: "move" | "hold" | "recovery" | "post";
    if (block <= ev.extremeBlock)             phase = "move";
    else if (block < ev.recoveryStartBlock)   phase = "hold";
    else if (block <= ev.recoveredBlock)      phase = "recovery";
    else                                       phase = "post";
    return { ...ev, phase };
  }
  return null;
}

// ── Per-block CSV reader (full inherent votes) ───────────────────────────────
// The chunked .simdata only stores summary arrays — the full per-block list of
// inherent submissions (each input's validator type + value) lives ONLY in the
// per-scenario CSV written alongside it (`<dir>.csv`, one row per block in
// order, block N at line index N+1 after the header). The block-detail page
// needs those individual votes, so we scan the CSV for the single target row.
//
// Scan cost is O(targetBlock) lines, but a block-detail open is a rare,
// user-initiated action (one click) and the typical smoke-test sim is well
// under ~100k blocks, so a streaming scan with early-exit is fine.

interface ParsedVote {
  type: ValidatorType;
  kind: "quote" | "nudge";
  price?: number;
  bump?: number;
}

interface CsvBlockRow {
  authorIndex: number;
  authorType: ValidatorType;
  inherentTotal: number;
  inherentNonHonest: number;
  priceUpdated: boolean;
  oraclePrice: number;
  realPrice: number;
  medianValidatorType: string | null;
  votes: ParsedVote[];
}

/** Parse the `inherentVotes` payload (already CSV-unquoted). Format is
 *  `[(type, value); (type, value); ...]` or `[]`. `mode` disambiguates the
 *  value: nudge rows carry a signed bump (`+1`/`-1`), quote rows a price —
 *  passing the aggregator mode avoids mis-reading a quote price of -1 as a
 *  down bump. */
function parseInherentVotes(raw: string, mode: string): ParsedVote[] {
  let s = raw.trim();
  if (s.startsWith("[")) s = s.slice(1);
  if (s.endsWith("]")) s = s.slice(0, -1);
  s = s.trim();
  if (s.length === 0) return [];
  const out: ParsedVote[] = [];
  for (const entry of s.split("; ")) {
    const m = entry.match(/^\(\s*(.+?)\s*,\s*([^)]+)\)$/);
    if (!m) continue;
    const type = m[1].trim() as ValidatorType;
    const val = m[2].trim();
    if (mode === "nudge") {
      out.push({ type, kind: "nudge", bump: val.startsWith("-") ? -1 : 1 });
    } else {
      out.push({ type, kind: "quote", price: parseFloat(val) });
    }
  }
  return out;
}

/** Split one CSV data row into its fields. The first 12 columns are
 *  comma-free; the 13th (inherentVotes) is double-quoted and may contain
 *  commas/semicolons, so everything past the 12th comma is the votes payload. */
function parseCsvBlockRow(line: string, mode: string): CsvBlockRow | null {
  const trimmed = line.replace(/\r$/, "");
  let idx = 0;
  const cols: string[] = [];
  for (let k = 0; k < 12; k++) {
    const c = trimmed.indexOf(",", idx);
    if (c < 0) return null; // malformed / header
    cols.push(trimmed.slice(idx, c));
    idx = c + 1;
  }
  let votesRaw = trimmed.slice(idx);
  // Unwrap the CSV quoting the writer applied to the votes field.
  if (votesRaw.startsWith('"') && votesRaw.endsWith('"')) {
    votesRaw = votesRaw.slice(1, -1).replace(/""/g, '"');
  }
  const medType = cols[11];
  return {
    authorIndex: parseInt(cols[2], 10),
    authorType: cols[3] as ValidatorType,
    inherentTotal: parseInt(cols[4], 10),
    inherentNonHonest: parseInt(cols[5], 10),
    priceUpdated: cols[7] === "1",
    oraclePrice: parseFloat(cols[8]),
    realPrice: parseFloat(cols[9]),
    medianValidatorType: medType && medType !== "-" ? medType : null,
    votes: parseInherentVotes(votesRaw, mode),
  };
}

/** Stream a CSV file and return the line at `targetLineIdx` (0-based; line 0 is
 *  the header) plus the line immediately before it. Avoids reading the whole
 *  file into memory or past the target row. */
async function readCsvLineAt(
  path: string,
  targetLineIdx: number,
): Promise<{ line: string | null; prevLine: string | null }> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { line: null, prevLine: null };
  const decoder = new TextDecoder();
  let buf = "";
  let lineIdx = 0;
  let prevLine: string | null = null;
  // @ts-ignore — Bun's BunFile stream is async-iterable over Uint8Array chunks.
  for await (const chunk of file.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (lineIdx === targetLineIdx) return { line, prevLine };
      prevLine = line;
      lineIdx++;
    }
  }
  buf += decoder.decode();
  if (buf.length > 0 && lineIdx === targetLineIdx) return { line: buf, prevLine };
  return { line: null, prevLine };
}

/** Floor a timestamp to the block index using uniform 6s spacing from
 *  meta.timeRange.from. Clamps to [0, blockCount-1]. */
function blockAtTimestamp(meta: ScenarioMeta, ts: number): number {
  if (meta.blockCount === 0) return 0;
  if (ts <= meta.timeRange.from) return 0;
  if (ts >= meta.timeRange.to) return meta.blockCount - 1;
  const idx = Math.floor((ts - meta.timeRange.from) / BLOCK_TIME_SECONDS);
  return Math.max(0, Math.min(meta.blockCount - 1, idx));
}

function buildMetaResponse(
  index: SimDataIndex,
  filterIndices?: number[],
  timeConstraint?: { from: number; to: number },
): ApiMetaResponse {
  const indices = filterIndices ?? index.scenarios.map((_, i) => i);
  return {
    scenarioCount: indices.length,
    scenarios: indices.map((i) => {
      const sc = index.scenarios[i];
      let tr = sc.timeRange;
      if (timeConstraint) {
        tr = {
          from: Math.max(tr.from, timeConstraint.from),
          to: Math.min(tr.to, timeConstraint.to),
        };
      }
      return {
        index: i,
        config: sc.config,
        summary: sc.summary,
        timeRange: tr,
        blockCount: sc.blockCount,
      };
    }),
  };
}

async function loadScenarioRange(
  outputDir: string,
  scenarioIndex: number,
  meta: ScenarioMeta,
  from: number,
  to: number,
): Promise<{ timestamps: number[]; realPrices: number[]; oraclePrices: number[]; deviationPcts: number[] }> {
  const timestamps: number[] = [];
  const realPrices: number[] = [];
  const oraclePrices: number[] = [];
  const deviationPcts: number[] = [];
  const dir = scenarioDir(meta, scenarioIndex);

  for (let c = 0; c < meta.chunkCount; c++) {
    // Fast skip via chunk time ranges stored in index (avoids loading chunk from disk)
    if (meta.chunkTimeRanges && meta.chunkTimeRanges[c]) {
      const cr = meta.chunkTimeRanges[c];
      if (cr.to < from || cr.from > to) continue;
    }

    const chunk = await loadChunkCached(outputDir, dir, c);

    const chunkFrom = chunk.timestamps[0];
    const chunkTo = chunk.timestamps[chunk.timestamps.length - 1];
    if (chunkTo < from || chunkFrom > to) continue;

    for (let i = 0; i < chunk.blockCount; i++) {
      const t = chunk.timestamps[i];
      if (t < from) continue;
      if (t > to) break;
      timestamps.push(t);
      realPrices.push(chunk.realPrices[i]);
      oraclePrices.push(chunk.oraclePrices[i]);
      deviationPcts.push(chunk.deviationPcts[i]);
    }
  }

  return { timestamps, realPrices, oraclePrices, deviationPcts };
}

function parseScenarioFilter(raw: string, allowedIndices?: number[]): number[] | "all" {
  if (raw === "all") return "all";
  const indices = raw.split(",").map(Number).filter((n) => !isNaN(n));
  if (indices.length === 0) return "all";
  if (allowedIndices) return indices.filter((i) => allowedIndices.includes(i));
  return indices;
}

async function buildDataResponse(
  outputDir: string,
  index: SimDataIndex,
  venues: VenuesFile | null,
  from: number,
  to: number,
  tf: number,
  scenarioFilter: string,
  allowedIndices?: number[],
): Promise<ApiDataResponse> {
  const requestedTF = tf;

  const span = to - from;
  const pad = span * OVER_FETCH_RATIO;
  const paddedFrom = from - pad;
  const paddedTo = to + pad;

  const windowSpan = paddedTo - paddedFrom;
  while (windowSpan / tf > MAX_CANDLES && tf < TIMEFRAMES[TIMEFRAMES.length - 1]) {
    tf = nextTF(tf);
  }

  const parsed = parseScenarioFilter(scenarioFilter, allowedIndices);
  let scenarioIndices: number[];
  if (parsed === "all") {
    scenarioIndices = allowedIndices ?? index.scenarios.map((_, i) => i);
  } else {
    scenarioIndices = parsed.length > 0 ? parsed : (allowedIndices ?? index.scenarios.map((_, i) => i));
  }

  const firstIdx = scenarioIndices[0];
  const firstData = await loadScenarioRange(outputDir, firstIdx, index.scenarios[firstIdx], paddedFrom, paddedTo);
  const realOhlc = aggregateOHLC(firstData.timestamps, firstData.realPrices, paddedFrom, paddedTo, tf);
  const realLine = aggregateLine(firstData.timestamps, firstData.realPrices, paddedFrom, paddedTo, tf);

  const oracles = await Promise.all(scenarioIndices.map(async (idx) => {
    const data = idx === firstIdx
      ? firstData
      : await loadScenarioRange(outputDir, idx, index.scenarios[idx], paddedFrom, paddedTo);
    return {
      index: idx,
      label: index.scenarios[idx].config.label,
      ohlc: aggregateOHLC(data.timestamps, data.oraclePrices, paddedFrom, paddedTo, tf),
      line: aggregateLine(data.timestamps, data.oraclePrices, paddedFrom, paddedTo, tf),
      deviation: aggregateDeviation(data.timestamps, data.deviationPcts, paddedFrom, paddedTo, tf),
    };
  }));

  let venuesResp: Record<string, LinePoint[]> | undefined;
  let venueVolumesResp: Record<string, LinePoint[]> | undefined;
  if (venues) {
    venuesResp = {};
    for (const [vid, prices] of Object.entries(venues.venues)) {
      venuesResp[vid] = aggregateLine(venues.timestamps, prices, paddedFrom, paddedTo, tf);
    }
    // Volumes use SUM aggregation (additive across the bucket), not the
    // last-value behavior `aggregateLine` would give. Optional: legacy
    // .simdata dirs without `volumes` simply skip this branch.
    if (venues.volumes) {
      venueVolumesResp = {};
      for (const [vid, vols] of Object.entries(venues.volumes)) {
        venueVolumesResp[vid] = aggregateVolume(venues.timestamps, vols, paddedFrom, paddedTo, tf);
      }
    }
  }

  return {
    tf,
    requestedTF,
    from: paddedFrom,
    to: paddedTo,
    realPrice: { ohlc: realOhlc, line: realLine },
    oracles,
    venues: venuesResp,
    venueVolumes: venueVolumesResp,
  };
}

export async function startServer(
  outputDir: string,
  port: number,
  openBrowser: boolean,
  filterIndices?: number[],
  timeConstraint?: { from: number; to: number },
): Promise<void> {
  const index = await loadIndex(outputDir);
  const venues = await loadVenues(outputDir);
  const events = await loadEvents(outputDir);
  const templateHtml = await Bun.file(TEMPLATE_PATH).text();
  const blockTemplateHtml = await Bun.file(BLOCK_TEMPLATE_PATH).text();
  const metaResponse = JSON.stringify(buildMetaResponse(index, filterIndices, timeConstraint));

  const reportPath = join(outputDir, "research_report.json");
  const researchJson = existsSync(reportPath) ? await Bun.file(reportPath).text() : null;

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/") {
        return new Response(templateHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/api/meta") {
        return new Response(metaResponse, {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      if (url.pathname === "/api/research") {
        if (!researchJson) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(researchJson, {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      if (url.pathname === "/api/block") {
        // Hover-tooltip lookup: which block was authored by whom at this time,
        // for which scenarios. Lightweight; cache makes it O(1) post-warmup.
        const scenarioParam = url.searchParams.get("scenarios") ?? "all";
        const time = parseFloat(url.searchParams.get("time") ?? "0");
        if (isNaN(time)) {
          return new Response(JSON.stringify({ error: "Invalid time" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const parsed = parseScenarioFilter(scenarioParam, filterIndices);
        const allowed = filterIndices ?? index.scenarios.map((_, i) => i);
        const scenarioIndices = parsed === "all" ? allowed : (parsed.length > 0 ? parsed : allowed);

        if (scenarioIndices.length === 0) {
          return new Response(JSON.stringify({ block: 0, timestamp: time, authors: [] }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        // All scenarios share the same block timeline (driven by the price
        // source, not the validator config), so resolve block from the first.
        const refMeta = index.scenarios[scenarioIndices[0]];
        const block = blockAtTimestamp(refMeta, time);
        const blockTimestamp = refMeta.timeRange.from + block * BLOCK_TIME_SECONDS;

        const authors = await Promise.all(scenarioIndices.map(async (idx) => {
          const meta = index.scenarios[idx];
          const arr = getAuthorIndices(meta, idx);
          // Clamp in case scenarios disagree on blockCount (shouldn't happen).
          const safeBlock = Math.min(block, arr.length - 1);
          const authorIdx = arr[safeBlock] ?? 0;
          const type = validatorTypeAt(meta.config.validators, authorIdx);

          // Resolve the per-block debug fields from the chunk file (when
          // present). Pre-existing simdata directories without these arrays
          // fall back to the safe defaults: priceUpdated=true, inherentTotal=null,
          // medianValidatorType=null. The hover tooltip degrades gracefully.
          let priceUpdated: boolean | null = null;
          let inherentTotal: number | null = null;
          let medianValidatorType: string | null = null;
          let agreementRate: number | null = null;
          let epsilonCoefficient: number | null = null;
          try {
            const chunkIdx = Math.floor(safeBlock / BLOCKS_PER_CHUNK);
            const dir = scenarioDir(meta, idx);
            const chunk = await loadChunkCached(outputDir, dir, chunkIdx);
            const tickInChunk = safeBlock - chunk.blockOffset;
            if (chunk.priceUpdated && tickInChunk >= 0 && tickInChunk < chunk.priceUpdated.length) {
              priceUpdated = chunk.priceUpdated[tickInChunk] === 1;
            }
            if (chunk.inherentTotals && tickInChunk >= 0 && tickInChunk < chunk.inherentTotals.length) {
              inherentTotal = chunk.inherentTotals[tickInChunk];
            }
            if (chunk.medianValidatorIndices && tickInChunk >= 0 && tickInChunk < chunk.medianValidatorIndices.length) {
              const mvi = chunk.medianValidatorIndices[tickInChunk];
              if (mvi >= 0) medianValidatorType = validatorTypeAt(meta.config.validators, mvi);
            }
            // -1 sentinel means "not applicable" (median agg, or freeze block).
            if (chunk.agreementRates && tickInChunk >= 0 && tickInChunk < chunk.agreementRates.length) {
              const ar = chunk.agreementRates[tickInChunk];
              if (ar >= 0) agreementRate = ar;
            }
            if (chunk.epsilonCoefficients && tickInChunk >= 0 && tickInChunk < chunk.epsilonCoefficients.length) {
              const ec = chunk.epsilonCoefficients[tickInChunk];
              if (ec >= 0) epsilonCoefficient = ec;
            }
          } catch {
            // Older simdata directories without the per-block arrays — fall through.
          }

          return {
            scenario: idx, label: meta.config.label, index: authorIdx, type,
            priceUpdated, inherentTotal, medianValidatorType,
            agreementRate, epsilonCoefficient,
          };
        }));

        // Synthetic-only: resolve which event (if any) this block belongs to.
        // Returned as a structural payload — null when between events or when
        // the simdata wasn't produced from synthetic data.
        const event = events ? findEventForBlock(events, block) : null;

        return new Response(JSON.stringify({ block, timestamp: blockTimestamp, authors, event }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      if (url.pathname === "/block") {
        // Standalone per-block detail page. It pulls everything it needs from
        // /api/meta + /api/block-detail; the route just serves the shell.
        return new Response(blockTemplateHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/api/block-detail") {
        // Full per-block detail for ONE scenario: author, prices, and the
        // complete inherent vote list (read from the scenario's CSV). Static
        // config/summary the page already has from /api/meta — this endpoint
        // only returns the per-block dynamic data.
        const scenarioIdx = parseInt(url.searchParams.get("scenario") ?? "", 10);
        const timeParam = url.searchParams.get("time");
        const blockParam = url.searchParams.get("block");
        if (isNaN(scenarioIdx) || scenarioIdx < 0 || scenarioIdx >= index.scenarios.length) {
          return new Response(JSON.stringify({ error: "Invalid scenario" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        // Respect the active filter so a URL can't reach a hidden scenario.
        if (filterIndices && !filterIndices.includes(scenarioIdx)) {
          return new Response(JSON.stringify({ error: "Scenario not served" }), {
            status: 404, headers: { "Content-Type": "application/json" },
          });
        }

        const meta = index.scenarios[scenarioIdx];
        let block: number;
        if (blockParam !== null && !isNaN(parseInt(blockParam, 10))) {
          block = Math.max(0, Math.min(meta.blockCount - 1, parseInt(blockParam, 10)));
        } else {
          const time = parseFloat(timeParam ?? "");
          if (isNaN(time)) {
            return new Response(JSON.stringify({ error: "Invalid time/block" }), {
              status: 400, headers: { "Content-Type": "application/json" },
            });
          }
          block = blockAtTimestamp(meta, time);
        }
        const blockTimestamp = meta.timeRange.from + block * BLOCK_TIME_SECONDS;
        const mode = meta.config.aggregator?.kind ?? "median";

        // Full votes + author + prices from the CSV row (and the prior row for
        // the pre-block oracle price).
        const dir = scenarioDir(meta, scenarioIdx);
        const csvPath = join(outputDir, `${dir}.csv`);
        const { line, prevLine } = await readCsvLineAt(csvPath, block + 1);
        const row = line ? parseCsvBlockRow(line, mode) : null;

        // Per-block diagnostics not in the CSV (agreement rate, ε coefficient,
        // median validator index) come from the chunk. Best-effort.
        let agreementRate: number | null = null;
        let epsilonCoefficient: number | null = null;
        let medianValidatorIndex: number | null = null;
        let initialPrice: number | null = null;
        try {
          const chunkIdx = Math.floor(block / BLOCKS_PER_CHUNK);
          const chunk = await loadChunkCached(outputDir, dir, chunkIdx);
          const tick = block - chunk.blockOffset;
          if (chunk.agreementRates && tick >= 0 && tick < chunk.agreementRates.length) {
            const ar = chunk.agreementRates[tick];
            if (ar >= 0) agreementRate = ar;
          }
          if (chunk.epsilonCoefficients && tick >= 0 && tick < chunk.epsilonCoefficients.length) {
            const ec = chunk.epsilonCoefficients[tick];
            if (ec >= 0) epsilonCoefficient = ec;
          }
          if (chunk.medianValidatorIndices && tick >= 0 && tick < chunk.medianValidatorIndices.length) {
            const mvi = chunk.medianValidatorIndices[tick];
            if (mvi >= 0) medianValidatorIndex = mvi;
          }
          // Block 0's "previous" price is the chain's initial price = the first
          // real price. Only chunk 0 carries it; only needed when block === 0.
          if (chunkIdx === 0 && chunk.realPrices.length > 0) initialPrice = chunk.realPrices[0];
        } catch {
          // Legacy simdata without these arrays — degrade gracefully.
        }

        const validators = meta.config.validators;
        const prevRow = prevLine ? parseCsvBlockRow(prevLine, mode) : null;
        const prevPrice = block === 0
          ? initialPrice
          : (prevRow ? prevRow.oraclePrice : null);

        const medianValidator = medianValidatorIndex !== null
          ? { index: medianValidatorIndex, type: validatorTypeAt(validators, medianValidatorIndex) }
          : (row?.medianValidatorType ? { index: null, type: row.medianValidatorType } : null);

        const payload = {
          scenario: scenarioIdx,
          label: meta.config.label,
          block,
          timestamp: blockTimestamp,
          found: row !== null,
          author: row
            ? { index: row.authorIndex, type: row.authorType, isHonest: row.authorType === "honest" }
            : null,
          prevPrice,
          newPrice: row ? row.oraclePrice : null,
          realPrice: row ? row.realPrice : null,
          priceUpdated: row ? row.priceUpdated : null,
          inherentTotal: row ? row.inherentTotal : null,
          inherentNonHonest: row ? row.inherentNonHonest : null,
          medianValidator,
          agreementRate,
          epsilonCoefficient,
          votes: row ? row.votes : [],
        };
        return new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      if (url.pathname === "/api/data") {
        const scenario = url.searchParams.get("scenario") ?? "all";
        const from = parseFloat(url.searchParams.get("from") ?? "0");
        const to = parseFloat(url.searchParams.get("to") ?? String(Date.now() / 1000));
        const tf = parseInt(url.searchParams.get("tf") ?? "900");

        if (isNaN(from) || isNaN(to) || isNaN(tf)) {
          return new Response(JSON.stringify({ error: "Invalid parameters" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const result = await buildDataResponse(outputDir, index, venues, from, to, tf, scenario, filterIndices);
        return new Response(JSON.stringify(result), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const url = `http://localhost:${server.port}`;
  console.log(`Server running at ${url}`);

  if (openBrowser) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  }

  console.log("Press Ctrl+C to stop the server.");

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      console.log("\nStopping server...");
      server.stop();
      resolve();
    });
    process.on("SIGTERM", () => {
      server.stop();
      resolve();
    });
  });
}

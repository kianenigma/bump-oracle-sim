import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { VenueBucket, VenueSpotSource, RawTrade } from "../types.js";
import { BLOCKS_PER_DAY } from "../types.js";
import { bucketizeDay, dayStartSec } from "../aggregate.js";
import { readBucketCache, writeBucketCache } from "../cache.js";

// Binance.com (NOT Binance US) spot trade dumps live at data.binance.vision.
// Schema (no header row in recent dumps):
//   id, price, qty, quote_qty, time, is_buyer_maker, is_best_match
// `time` is millisecond Unix timestamp.
// One zip per (pair, date), one CSV inside. Daily file ~10 MB compressed for DOTUSDT.

const PAIR = "DOTUSDT";
const RULE = "vwap" as const;

function dumpUrl(pair: string, date: string): string {
  return `https://data.binance.vision/data/spot/daily/trades/${pair}/${pair}-trades-${date}.zip`;
}

async function fetchAndParse(url: string): Promise<RawTrade[]> {
  // Stream the zip to a temp file. Keeping it on disk lets us shell out to
  // `unzip` without juggling pipes; the zip is ~10 MB, cleaned up below.
  const tStart = Date.now();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance: fetch ${url} failed with ${res.status} ${res.statusText}`);
  }
  const tmpZip = join(tmpdir(), `oracle-sim-binance-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  const tmpCsv = tmpZip.replace(/\.zip$/, ".csv");
  // Read body explicitly. `Bun.write(path, response)` has been observed to
  // hang on this 10 MB binary stream in some Bun versions; arrayBuffer()
  // works reliably.
  const buf = await res.arrayBuffer();
  await Bun.write(tmpZip, buf);
  const tDownload = Date.now() - tStart;

  try {
    // Unzip directly to a CSV temp file. Avoids piping a 50–100 MB stream
    // through stdout into a JS string buffer (which is fragile and slow).
    const proc = Bun.spawn(["unzip", "-p", tmpZip], { stdout: Bun.file(tmpCsv) });
    const exit = await proc.exited;
    if (exit !== 0) throw new Error(`Binance: unzip exited with code ${exit} for ${url}`);
    const csvSize = Bun.file(tmpCsv).size;
    const tUnzip = Date.now() - tStart - tDownload;

    const text = await Bun.file(tmpCsv).text();
    const parsed = parseBinanceTradesCsv(text);
    const tParse = Date.now() - tStart - tDownload - tUnzip;
    console.log(`    download=${tDownload}ms zip=${(buf.byteLength / 1024 / 1024).toFixed(1)}MB; unzip=${tUnzip}ms csv=${(csvSize / 1024 / 1024).toFixed(1)}MB; parse=${tParse}ms (${parsed.length.toLocaleString()} trades)`);
    return parsed;
  } finally {
    try { unlinkSync(tmpZip); } catch { /* best-effort */ }
    try { unlinkSync(tmpCsv); } catch { /* best-effort */ }
  }
}

/** Parse the Binance.com spot trades CSV.
 *  Schema: id, price, qty, quote_qty, time, is_buyer_maker, is_best_match
 *  - Older dumps had a header row (skipped: first char isn't a digit).
 *  - The `time` column has been in milliseconds historically and is
 *    microseconds in recent dumps (≥2024). Auto-detected by magnitude:
 *    a value > 1e14 must be microseconds (year-3000+ in ms), and any value
 *    > 1e11 must already be milliseconds (year-3000+ in s). */
function parseBinanceTradesCsv(text: string): RawTrade[] {
  const lines = text.split("\n");
  const trades: RawTrade[] = new Array(lines.length);
  let n = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.length === 0) continue;
    const c0 = line.charCodeAt(0);
    if (c0 < 48 || c0 > 57) continue;  // skip header / non-trade rows
    const parts = line.split(",");
    if (parts.length < 5) continue;
    const price = +parts[1];
    const qty = +parts[2];
    const timeRaw = +parts[4];
    if (!(price > 0) || !(qty > 0) || !(timeRaw > 0)) continue;
    const timeSec = timeRaw > 1e14 ? timeRaw / 1e6 : timeRaw > 1e11 ? timeRaw / 1e3 : timeRaw;
    trades[n++] = { timestampSec: timeSec, price, qty };
  }
  trades.length = n;
  return trades;
}

export class BinanceSpotSource implements VenueSpotSource {
  readonly id = "binance" as const;
  readonly pair = PAIR;

  async loadDay(date: string): Promise<VenueBucket[]> {
    const cached = await readBucketCache(this.id, this.pair, date, RULE);
    if (cached) return cached;

    const url = dumpUrl(this.pair, date);
    console.log(`  [binance ${date}] downloading ${url}`);
    const trades = await fetchAndParse(url);
    const buckets = bucketizeDay(trades, dayStartSec(date));
    if (buckets.length !== BLOCKS_PER_DAY) {
      throw new Error(`binance: expected ${BLOCKS_PER_DAY} buckets, got ${buckets.length}`);
    }
    const populated = buckets.reduce((n, b) => n + (b.vwap !== null ? 1 : 0), 0);
    console.log(`  [binance ${date}] ${trades.length.toLocaleString()} trades → ${populated}/${BLOCKS_PER_DAY} populated buckets`);
    // Safety: refuse to cache an empty result. This usually means a parser
    // mismatch (e.g. timestamp unit changed); caching it would silently mask
    // the bug across reruns until manually cleared.
    if (populated === 0 && trades.length > 0) {
      throw new Error(
        `Binance: ${trades.length} trades parsed but 0 buckets populated for ${date}. ` +
        `Likely a timestamp-unit mismatch in the CSV; check parser.`
      );
    }
    await writeBucketCache(this.id, this.pair, date, RULE, buckets);
    return buckets;
  }
}

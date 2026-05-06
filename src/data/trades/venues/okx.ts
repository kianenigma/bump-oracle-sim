import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { VenueBucket, VenueSpotSource, RawTrade } from "../types.js";
import { BLOCKS_PER_DAY } from "../types.js";
import { bucketizeDay, dayStartSec } from "../aggregate.js";
import { readBucketCache, writeBucketCache } from "../cache.js";

// OKX spot trade dumps live at okx.com/cdn/okex/traderecords/.
// URL pattern (verified):
//   https://www.okx.com/cdn/okex/traderecords/trades/daily/<YYYYMMDD>/<PAIR>-trades-<YYYY-MM-DD>.zip
//
// Header row (recent dumps):
//   instrument_name, trade_id, side, price, size, created_time
// `created_time` is millisecond Unix timestamp.
// First column is a string ("DOT-USDT") — the digit-prefix header skip used by
// other venues won't work here; we instead drop any line whose price/size/time
// columns don't parse as numbers.
//
// IMPORTANT — HKT day boundaries:
//   OKX rolls dumps at midnight Hong Kong Time (UTC+8). The file labeled
//   `<YYYYMMDD>` covers HKT [00:00, 24:00) — i.e. UTC [<date-1> 16:00,
//   <date> 16:00). To populate a full UTC day D, we fetch BOTH the file
//   labeled D (gives us UTC 00:00–16:00 of D) and the file labeled D+1
//   (gives us UTC 16:00–24:00 of D), then let bucketizeDay filter to the
//   UTC window. If the D+1 file is missing (e.g. running this on the day
//   D), we keep whatever we got from D and proceed with partial coverage.
//
// Bulk data only goes back to mid-2021. Older dates 404 and we throw.

const PAIR = "DOT-USDT";
const RULE = "vwap" as const;

function dumpUrl(pair: string, date: string): string {
  const yyyymmdd = date.replace(/-/g, "");
  return `https://www.okx.com/cdn/okex/traderecords/trades/daily/${yyyymmdd}/${pair}-trades-${date}.zip`;
}

/** Download + unzip + parse a single OKX dump file. Returns trades or [] if 404. */
async function fetchOneDump(url: string, label: string, allowMissing: boolean): Promise<RawTrade[]> {
  const tStart = Date.now();
  const tmpZip = join(tmpdir(), `oracle-sim-okx-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  const tmpCsv = tmpZip.replace(/\.zip$/, ".csv");

  // Bun's fetch fails TLS verification against okx.com in some environments
  // ("UNKNOWN_CERTIFICATE_VERIFICATION_ERROR"), while system curl works fine.
  // Shell out to curl rather than disabling rejectUnauthorized — the rest of
  // this file already shells out to `unzip`, so adding `curl` is consistent.
  const dlProc = Bun.spawn([
    "curl", "-sSL", "--max-time", "120", "-w", "%{http_code}", "-o", tmpZip, url,
  ], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(dlProc.stdout).text();
  const dlExit = await dlProc.exited;
  const httpCode = parseInt(stdout.trim(), 10);
  if (dlExit !== 0 || !(httpCode >= 200 && httpCode < 300)) {
    try { unlinkSync(tmpZip); } catch {}
    if (httpCode === 404 && allowMissing) {
      console.log(`    [okx] ${label} not yet available (404) — proceeding with partial coverage`);
      return [];
    }
    throw new Error(`OKX: curl ${url} returned HTTP ${httpCode} (note: OKX has no bulk data before mid-2021)`);
  }
  const tDownload = Date.now() - tStart;
  const zipSize = Bun.file(tmpZip).size;
  if (zipSize === 0) {
    try { unlinkSync(tmpZip); } catch {}
    throw new Error(`OKX: downloaded zip is empty for ${url}`);
  }

  try {
    const proc = Bun.spawn(["unzip", "-p", tmpZip], { stdout: Bun.file(tmpCsv) });
    const exit = await proc.exited;
    if (exit !== 0) throw new Error(`OKX: unzip exited with code ${exit} for ${url}`);
    const csvSize = Bun.file(tmpCsv).size;
    const tUnzip = Date.now() - tStart - tDownload;

    const text = await Bun.file(tmpCsv).text();
    const parsed = parseOkxTradesCsv(text);
    const tParse = Date.now() - tStart - tDownload - tUnzip;
    console.log(`    [okx ${label}] download=${tDownload}ms zip=${(zipSize / 1024 / 1024).toFixed(2)}MB; unzip=${tUnzip}ms csv=${(csvSize / 1024 / 1024).toFixed(1)}MB; parse=${tParse}ms (${parsed.length.toLocaleString()} trades)`);
    return parsed;
  } finally {
    try { unlinkSync(tmpZip); } catch { /* best-effort */ }
    try { unlinkSync(tmpCsv); } catch { /* best-effort */ }
  }
}

/** Returns the YYYY-MM-DD that follows the given UTC date. */
function nextUtcDay(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Parse the OKX spot trades CSV.
 *  Schema (with header row in current dumps):
 *    instrument_name, trade_id, side, price, size, created_time
 *  - Header row is skipped because parts[3] / parts[4] / parts[5] don't parse.
 *  - `created_time` is in milliseconds; we still auto-detect the magnitude
 *    in case OKX changes units the way Binance did (ms → µs in 2024). */
function parseOkxTradesCsv(text: string): RawTrade[] {
  const lines = text.split("\n");
  const trades: RawTrade[] = new Array(lines.length);
  let n = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.length === 0) continue;
    const parts = line.split(",");
    if (parts.length < 6) continue;
    const price = +parts[3];
    const qty = +parts[4];
    const timeRaw = +parts[5];
    if (!(price > 0) || !(qty > 0) || !(timeRaw > 0)) continue;
    const timeSec = timeRaw > 1e14 ? timeRaw / 1e6 : timeRaw > 1e11 ? timeRaw / 1e3 : timeRaw;
    trades[n++] = { timestampSec: timeSec, price, qty };
  }
  trades.length = n;
  return trades;
}

export class OkxSpotSource implements VenueSpotSource {
  readonly id = "okx" as const;
  readonly pair = PAIR;

  async loadDay(date: string): Promise<VenueBucket[]> {
    const cached = await readBucketCache(this.id, this.pair, date, RULE);
    if (cached) return cached;

    // Fetch both the same-labeled dump and the next-day dump to cover the
    // full UTC day (see HKT-boundary note at the top of this file).
    const dateNext = nextUtcDay(date);
    console.log(`  [okx ${date}] HKT-boundary fix: fetching dumps ${date} + ${dateNext}`);

    const [tradesA, tradesB] = await Promise.all([
      fetchOneDump(dumpUrl(this.pair, date), date, /* allowMissing */ false),
      fetchOneDump(dumpUrl(this.pair, dateNext), dateNext, /* allowMissing */ true),
    ]);
    const trades = tradesA.concat(tradesB);

    const buckets = bucketizeDay(trades, dayStartSec(date));
    if (buckets.length !== BLOCKS_PER_DAY) {
      throw new Error(`okx: expected ${BLOCKS_PER_DAY} buckets, got ${buckets.length}`);
    }
    const populated = buckets.reduce((n, b) => n + (b.vwap !== null ? 1 : 0), 0);
    console.log(`  [okx ${date}] ${trades.length.toLocaleString()} trades → ${populated}/${BLOCKS_PER_DAY} populated buckets`);
    if (populated === 0 && trades.length > 0) {
      throw new Error(
        `OKX: ${trades.length} trades parsed but 0 buckets populated for ${date}. ` +
        `Likely a column-order or timestamp-unit mismatch; inspect the dump CSV.`
      );
    }
    await writeBucketCache(this.id, this.pair, date, RULE, buckets);
    return buckets;
  }
}

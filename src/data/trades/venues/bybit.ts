import type { VenueBucket, VenueSpotSource, RawTrade } from "../types.js";
import { BLOCKS_PER_DAY } from "../types.js";
import { bucketizeDay, dayStartSec } from "../aggregate.js";
import { readBucketCache, writeBucketCache } from "../cache.js";
import { downloadAndGunzip } from "../gunzip.js";

// Bybit spot trade dumps: https://public.bybit.com/spot/<PAIR>/<PAIR>_<YYYY-MM-DD>.csv.gz
// Schema (with header):
//   id, timestamp, price, volume, side, rpi
// `timestamp` is milliseconds since epoch.

const PAIR = "DOTUSDT";
const RULE = "vwap" as const;

function dumpUrl(pair: string, date: string): string {
  return `https://public.bybit.com/spot/${pair}/${pair}_${date}.csv.gz`;
}

/** Parse the Bybit spot trades CSV. Skips the header row by detecting non-digit first char. */
function parseBybitTradesCsv(text: string): RawTrade[] {
  const lines = text.split("\n");
  const trades: RawTrade[] = new Array(lines.length);
  let n = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.length === 0) continue;
    const c0 = line.charCodeAt(0);
    if (c0 < 48 || c0 > 57) continue;
    const parts = line.split(",");
    if (parts.length < 4) continue;
    const timeRaw = +parts[1];
    const price = +parts[2];
    const qty = +parts[3];
    if (!(price > 0) || !(qty > 0) || !(timeRaw > 0)) continue;
    // Bybit emits ms; defensive auto-detect in case they ever switch units.
    const timeSec = timeRaw > 1e14 ? timeRaw / 1e6 : timeRaw > 1e11 ? timeRaw / 1e3 : timeRaw;
    trades[n++] = { timestampSec: timeSec, price, qty };
  }
  trades.length = n;
  return trades;
}

export class BybitSpotSource implements VenueSpotSource {
  readonly id = "bybit" as const;
  readonly pair = PAIR;

  async loadDay(date: string): Promise<VenueBucket[]> {
    const cached = await readBucketCache(this.id, this.pair, date, RULE);
    if (cached) return cached;

    const url = dumpUrl(this.pair, date);
    console.log(`  [bybit ${date}] downloading ${url}`);
    const { text, zipBytes, csvBytes, downloadMs, unzipMs } = await downloadAndGunzip(url, "bybit");
    const trades = parseBybitTradesCsv(text);
    console.log(`    download=${downloadMs}ms zip=${(zipBytes / 1024 / 1024).toFixed(2)}MB; gunzip=${unzipMs}ms csv=${(csvBytes / 1024 / 1024).toFixed(1)}MB; ${trades.length.toLocaleString()} trades`);

    const buckets = bucketizeDay(trades, dayStartSec(date));
    if (buckets.length !== BLOCKS_PER_DAY) {
      throw new Error(`bybit: expected ${BLOCKS_PER_DAY} buckets, got ${buckets.length}`);
    }
    const populated = buckets.reduce((n, b) => n + (b.vwap !== null ? 1 : 0), 0);
    console.log(`  [bybit ${date}] ${trades.length.toLocaleString()} trades → ${populated}/${BLOCKS_PER_DAY} populated buckets`);
    if (populated === 0 && trades.length > 0) {
      throw new Error(
        `Bybit: ${trades.length} trades parsed but 0 buckets populated for ${date}. ` +
        `Likely a timestamp-unit or column-order mismatch; check parser.`
      );
    }
    await writeBucketCache(this.id, this.pair, date, RULE, buckets);
    return buckets;
  }
}

import type { VenueBucket, VenueSpotSource, RawTrade } from "../types.js";
import { BLOCKS_PER_DAY } from "../types.js";
import { bucketizeDay, dayStartSec } from "../aggregate.js";
import { readBucketCache, writeBucketCache } from "../cache.js";
import { downloadAndGunzip } from "../gunzip.js";

// Gate.io spot deals: https://download.gatedata.org/spot/deals/<YYYYMM>/<PAIR>-<YYYYMM>.csv.gz
// Schema (no header):
//   timestamp, dealid, price, amount, side
// `timestamp` is a float: seconds since epoch with microsecond fractional (e.g. "1759276806.976747").
//
// Gate publishes one file per month (~7 MB compressed for DOT_USDT). To keep
// per-day caching consistent with the other venues, on a cache miss for any
// day we download the whole month, bucketize per UTC day, and write all of
// that month's per-day cache files at once.

const PAIR = "DOT_USDT";
const RULE = "vwap" as const;

function monthUrl(pair: string, yyyymm: string): string {
  return `https://download.gatedata.org/spot/deals/${yyyymm}/${pair}-${yyyymm}.csv.gz`;
}

/** Parse the Gate spot deals CSV — no header. timestamp,dealid,price,amount,side. */
function parseGateDealsCsv(text: string): RawTrade[] {
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
    const timestampSec = +parts[0];   // seconds float w/ µs precision
    const price = +parts[2];
    const qty = +parts[3];
    if (!(price > 0) || !(qty > 0) || !(timestampSec > 0)) continue;
    trades[n++] = { timestampSec, price, qty };
  }
  trades.length = n;
  return trades;
}

/** Days in a UTC month, as YYYY-MM-DD strings. */
function daysInMonth(yyyymm: string): string[] {
  const year = parseInt(yyyymm.slice(0, 4), 10);
  const month = parseInt(yyyymm.slice(4, 6), 10);
  const out: string[] = [];
  let d = new Date(Date.UTC(year, month - 1, 1));
  while (d.getUTCMonth() === month - 1) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400_000);
  }
  return out;
}

export class GateSpotSource implements VenueSpotSource {
  readonly id = "gate" as const;
  readonly pair = PAIR;

  /** In-flight month downloads, deduped so back-to-back days hit one fetch. */
  private monthLocks = new Map<string, Promise<void>>();

  async loadDay(date: string): Promise<VenueBucket[]> {
    const cached = await readBucketCache(this.id, this.pair, date, RULE);
    if (cached) return cached;

    const yyyymm = date.slice(0, 4) + date.slice(5, 7);
    let lock = this.monthLocks.get(yyyymm);
    if (!lock) {
      lock = this.fetchAndCacheMonth(yyyymm);
      this.monthLocks.set(yyyymm, lock);
    }
    await lock;

    const fresh = await readBucketCache(this.id, this.pair, date, RULE);
    if (!fresh) {
      throw new Error(`Gate: ${date} still missing after fetching month ${yyyymm}`);
    }
    return fresh;
  }

  private async fetchAndCacheMonth(yyyymm: string): Promise<void> {
    const url = monthUrl(this.pair, yyyymm);
    console.log(`  [gate ${yyyymm}] downloading ${url}`);
    const { text, zipBytes, csvBytes, downloadMs, unzipMs } = await downloadAndGunzip(url, "gate");
    const trades = parseGateDealsCsv(text);
    console.log(`    download=${downloadMs}ms zip=${(zipBytes / 1024 / 1024).toFixed(2)}MB; gunzip=${unzipMs}ms csv=${(csvBytes / 1024 / 1024).toFixed(1)}MB; ${trades.length.toLocaleString()} trades for whole month`);

    // Bucketize each UTC day in the month independently. We pass the FULL trade
    // list to bucketizeDay each time; trades outside the day window are filtered
    // there. Cost: O(days × trades) but trades are already loaded so it's fast.
    const days = daysInMonth(yyyymm);
    let totalPopulated = 0;
    for (const date of days) {
      const buckets = bucketizeDay(trades, dayStartSec(date));
      const populated = buckets.reduce((n, b) => n + (b.vwap !== null ? 1 : 0), 0);
      totalPopulated += populated;
      await writeBucketCache(this.id, this.pair, date, RULE, buckets);
    }
    if (totalPopulated === 0 && trades.length > 0) {
      throw new Error(
        `Gate: ${trades.length} trades parsed for ${yyyymm} but 0 buckets populated across all days. ` +
        `Likely a timestamp-unit or column-order mismatch; check parser.`
      );
    }
    console.log(`  [gate ${yyyymm}] cached ${days.length} day-files; total populated buckets ${totalPopulated.toLocaleString()}/${(days.length * BLOCKS_PER_DAY).toLocaleString()}`);
  }
}

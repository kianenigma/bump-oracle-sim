import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { VenueId } from "../../types.js";
import type { VenueBucket, WithinVenueRule } from "./types.js";
import { BLOCKS_PER_DAY } from "./types.js";

// Cache root: <repo>/price-data/trades/<venue>/<pair>/<YYYY-MM-DD>.json
// Resolved relative to this file so it works from any cwd.
const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = join(HERE, "../../../price-data/trades");

interface OnDiskBuckets {
  venue: VenueId;
  pair: string;
  date: string;
  rule: WithinVenueRule;
  blocksPerDay: number;
  buckets: VenueBucket[];
}

function cachePath(venue: VenueId, pair: string, date: string): string {
  return join(CACHE_ROOT, venue, pair, `${date}.json`);
}

// When set, `readBucketCache` reports a miss for any (venue,pair,date) NOT yet
// re-written this session, forcing the venue source to re-download and
// re-bucketize. Used by --refresh-last-trade: the `lastTrade` field needs the
// raw trades, which only a re-fetch can supply for days cached before that
// field existed.
//
// The bypass is one-shot PER KEY: once a day has been (re)written this session
// it is no longer bypassed, so a source that writes then reads back its own
// fresh data (e.g. Gate downloads a whole month, caches each day, then reads
// the requested day) sees the just-written cache, and back-to-back days in the
// same month don't trigger a second download.
let bucketCacheBypass = false;
const refreshedKeys = new Set<string>();
const cacheKey = (venue: VenueId, pair: string, date: string) => `${venue}/${pair}/${date}`;

export function setBucketCacheBypass(bypass: boolean): void {
  bucketCacheBypass = bypass;
  if (!bypass) refreshedKeys.clear();
}

export async function readBucketCache(
  venue: VenueId,
  pair: string,
  date: string,
  rule: WithinVenueRule,
): Promise<VenueBucket[] | null> {
  if (bucketCacheBypass && !refreshedKeys.has(cacheKey(venue, pair, date))) return null;
  const path = cachePath(venue, pair, date);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as OnDiskBuckets;
    if (parsed.rule !== rule) return null;                   // stale: different aggregation rule
    if (parsed.blocksPerDay !== BLOCKS_PER_DAY) return null; // stale: grid changed
    if (parsed.buckets.length !== BLOCKS_PER_DAY) return null;
    return parsed.buckets;
  } catch {
    return null;  // unreadable cache file → treat as miss
  }
}

export async function writeBucketCache(
  venue: VenueId,
  pair: string,
  date: string,
  rule: WithinVenueRule,
  buckets: VenueBucket[],
): Promise<void> {
  const path = cachePath(venue, pair, date);
  mkdirSync(dirname(path), { recursive: true });
  const payload: OnDiskBuckets = {
    venue,
    pair,
    date,
    rule,
    blocksPerDay: BLOCKS_PER_DAY,
    buckets,
  };
  await Bun.write(path, JSON.stringify(payload));
  // Mark this day as freshly written so a subsequent read (even under bypass)
  // returns it — e.g. Gate's read-back after a month download.
  refreshedKeys.add(cacheKey(venue, pair, date));
}

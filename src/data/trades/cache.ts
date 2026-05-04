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

export async function readBucketCache(
  venue: VenueId,
  pair: string,
  date: string,
  rule: WithinVenueRule,
): Promise<VenueBucket[] | null> {
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
}

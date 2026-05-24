/**
 * For each venue, walk the cached daily files in ascending order and find
 * the first date where `populated / 14400 >= MIN_FRACTION`. Empty (0-trade)
 * cached files are skipped — they're recorded for dates before listing.
 *
 * Outputs each venue's first-real-data date plus the intersection.
 */
import { readdirSync, existsSync } from "fs";
import { join } from "path";

const VENUES = ["binance", "bybit", "coinbase", "gate", "kraken", "okx"];
const MIN_FRACTION = 0.10; // at least 10% of the day's 14400 buckets populated

interface VenueDay { date: string; populated: number; total: number; }

async function dayInfo(path: string): Promise<VenueDay | null> {
  try {
    const j = await Bun.file(path).json();
    let populated = 0;
    const total: number = j.buckets.length;
    for (const b of j.buckets) if (b.vwap !== null) populated++;
    const date: string = j.date;
    return { date, populated, total };
  } catch { return null; }
}

async function firstPopulated(venue: string): Promise<string | null> {
  const root = join("price-data/trades", venue);
  if (!existsSync(root)) return null;
  const subs = readdirSync(root);
  if (subs.length === 0) return null;
  const pairDir = join(root, subs[0]);
  const files = readdirSync(pairDir)
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .sort();
  for (const f of files) {
    const info = await dayInfo(join(pairDir, f));
    if (!info) continue;
    if (info.populated / info.total >= MIN_FRACTION) return info.date;
  }
  return null;
}

async function lastPopulated(venue: string): Promise<string | null> {
  const root = join("price-data/trades", venue);
  if (!existsSync(root)) return null;
  const subs = readdirSync(root);
  if (subs.length === 0) return null;
  const pairDir = join(root, subs[0]);
  const files = readdirSync(pairDir)
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .sort()
    .reverse();
  for (const f of files) {
    const info = await dayInfo(join(pairDir, f));
    if (!info) continue;
    if (info.populated / info.total >= MIN_FRACTION) return info.date;
  }
  return null;
}

async function main() {
  console.log(`Finding earliest/latest "real data" day per venue (≥ ${(MIN_FRACTION * 100).toFixed(0)}% buckets populated):\n`);
  let commonStart = "0000-00-00";
  let commonEnd = "9999-99-99";
  for (const v of VENUES) {
    const first = await firstPopulated(v);
    const last  = await lastPopulated(v);
    console.log(`  ${v.padEnd(10)} ${first ?? "(none)"} → ${last ?? "(none)"}`);
    if (first && first > commonStart) commonStart = first;
    if (last  && last  < commonEnd)   commonEnd   = last;
  }
  console.log(`\nIntersection (real data on all venues): ${commonStart} → ${commonEnd}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

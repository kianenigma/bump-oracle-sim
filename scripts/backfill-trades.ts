/**
 * Per-venue forward-fill + backward-probe driver.
 *
 *   Forward: from each venue's latest currently-cached date, fetch day-by-day
 *   up to `--end` (default: yesterday). Stops a venue on the first error.
 *
 *   Backward: from each venue's earliest currently-cached date, fetch
 *   day-by-day going backwards. Stops a venue after `--backward-tolerance`
 *   consecutive errors (default: 3) — a single network blip shouldn't end
 *   the probe, but a sustained string of 404s means we've gone past listing.
 *
 * After both passes, prints a table: per-venue (earliest, latest, daysAdded).
 *
 * Usage:
 *   bun run scripts/backfill-trades.ts [--end 2026-05-23] [--backward-tolerance 3]
 */

import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { BinanceSpotSource } from "../src/data/trades/venues/binance.js";
import { BybitSpotSource } from "../src/data/trades/venues/bybit.js";
import { GateSpotSource } from "../src/data/trades/venues/gate.js";
import { KrakenSpotSource } from "../src/data/trades/venues/kraken.js";
import { OkxSpotSource } from "../src/data/trades/venues/okx.js";
import { CoinbaseSpotSource } from "../src/data/trades/venues/coinbase.js";
import type { VenueSpotSource } from "../src/data/trades/types.js";
import type { VenueId } from "../src/types.js";

const VENUES: Array<VenueSpotSource> = [
  new BinanceSpotSource(),
  new BybitSpotSource(),
  new CoinbaseSpotSource(),
  new GateSpotSource(),
  new KrakenSpotSource(),
  new OkxSpotSource(),
];

const CACHE_ROOT = "price-data/trades";

function yesterdayISO(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** List the dates already cached for one venue, sorted ascending. */
function cachedDates(venueId: VenueId): string[] {
  const root = join(CACHE_ROOT, venueId);
  if (!existsSync(root)) return [];
  // Each venue stores under `<venueRoot>/<PAIR>/<date>.json`. We don't know
  // the PAIR string at this layer; just look at the first subdirectory.
  const subs = readdirSync(root);
  if (subs.length === 0) return [];
  const pairDir = join(root, subs[0]);
  if (!existsSync(pairDir)) return [];
  return readdirSync(pairDir)
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .map((n) => n.replace(/\.json$/, ""))
    .sort();
}

interface VenueRange { earliest: string; latest: string; }

function currentRange(venueId: VenueId): VenueRange | null {
  const dates = cachedDates(venueId);
  if (dates.length === 0) return null;
  return { earliest: dates[0], latest: dates[dates.length - 1] };
}

async function fillForward(
  src: VenueSpotSource,
  endDate: string,
  tolerance: number,
): Promise<{ added: number; newLatest: string | null }> {
  const range = currentRange(src.id);
  if (!range) {
    console.log(`  [${src.id}] no cached data — skipping forward fill`);
    return { added: 0, newLatest: null };
  }
  let cursor = addDays(range.latest, 1);
  let added = 0;
  let lastOk = range.latest;
  let consecutiveErrors = 0;
  while (cursor <= endDate && consecutiveErrors < tolerance) {
    try {
      await src.loadDay(cursor);
      lastOk = cursor;
      added++;
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      console.warn(`  [${src.id} ${cursor}] forward error (${consecutiveErrors}/${tolerance}): ${(e as Error).message.slice(0, 100)}`);
    }
    cursor = addDays(cursor, 1);
  }
  if (consecutiveErrors >= tolerance) {
    console.log(`  [${src.id}] forward-fill stopped after ${tolerance} consecutive errors at ${cursor}`);
  }
  return { added, newLatest: lastOk };
}

async function probeBackward(
  src: VenueSpotSource,
  tolerance: number,
): Promise<{ added: number; newEarliest: string | null }> {
  const range = currentRange(src.id);
  if (!range) {
    console.log(`  [${src.id}] no cached data — skipping backward probe`);
    return { added: 0, newEarliest: null };
  }
  let cursor = addDays(range.earliest, -1);
  let consecutiveErrors = 0;
  let added = 0;
  let earliestOk = range.earliest;
  // Stop if we'd go before any plausible listing date for any of these
  // venues. DOT mainnet launched 2020-05-26; the earliest data Binance has
  // is around 2020-08 (when DOT listed).
  const HARD_FLOOR = "2020-01-01";
  while (cursor >= HARD_FLOOR && consecutiveErrors < tolerance) {
    try {
      await src.loadDay(cursor);
      earliestOk = cursor;
      added++;
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      console.warn(`  [${src.id} ${cursor}] backward error (${consecutiveErrors}/${tolerance}): ${(e as Error).message.slice(0, 80)}`);
    }
    cursor = addDays(cursor, -1);
  }
  return { added, newEarliest: earliestOk };
}

async function main() {
  const args = process.argv.slice(2);
  const endIdx = args.indexOf("--end");
  const endDate = endIdx >= 0 ? args[endIdx + 1] : yesterdayISO();
  const tolIdx = args.indexOf("--backward-tolerance");
  const backwardTolerance = tolIdx >= 0 ? parseInt(args[tolIdx + 1]) : 3;
  const fwdTolIdx = args.indexOf("--forward-tolerance");
  const forwardTolerance = fwdTolIdx >= 0 ? parseInt(args[fwdTolIdx + 1]) : 5;

  console.log(`Backfill driver: end=${endDate}, forwardTolerance=${forwardTolerance}, backwardTolerance=${backwardTolerance}\n`);

  console.log(`=== Initial cache ranges ===`);
  for (const src of VENUES) {
    const r = currentRange(src.id);
    console.log(`  ${src.id.padEnd(10)} ${r ? `${r.earliest} → ${r.latest}` : "(empty)"}`);
  }

  console.log(`\n=== Forward-filling to ${endDate} ===`);
  for (const src of VENUES) {
    console.log(`\n--- ${src.id} ---`);
    const { added } = await fillForward(src, endDate, forwardTolerance);
    console.log(`  [${src.id}] forward-fill added ${added} day(s)`);
  }

  console.log(`\n=== Backward-probing (tolerance=${backwardTolerance}) ===`);
  for (const src of VENUES) {
    console.log(`\n--- ${src.id} ---`);
    const { added } = await probeBackward(src, backwardTolerance);
    console.log(`  [${src.id}] backward-probe added ${added} day(s)`);
  }

  console.log(`\n=== Final cache ranges ===`);
  let commonEarliest = "0000-00-00";
  let commonLatest   = "9999-99-99";
  for (const src of VENUES) {
    const r = currentRange(src.id);
    if (!r) continue;
    console.log(`  ${src.id.padEnd(10)} ${r.earliest} → ${r.latest}`);
    if (r.earliest > commonEarliest) commonEarliest = r.earliest;
    if (r.latest   < commonLatest)   commonLatest   = r.latest;
  }
  console.log(`\nCommon range across all venues: ${commonEarliest} → ${commonLatest}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

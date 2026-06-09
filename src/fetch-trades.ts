/**
 * Download the ENTIRE available per-venue spot-trade history into the local
 * bucket cache — each venue over its OWN listing→yesterday range, independently.
 *
 * Unlike the simulator / `--analyze-price` paths (which need one shared,
 * gap-free window and hard-fail on any missing day), this is a bulk pre-fetch:
 * days a venue can't serve — pre-listing, not-yet-published, or genuine gaps —
 * are skipped and logged, never fatal. Successful days are cached, so a later
 * sim or analysis over any sub-range reads from disk with no network.
 *
 * Usage:
 *   bun run src/fetch-trades.ts                       # all venues, full history
 *   bun run src/fetch-trades.ts --venues binance,okx  # a subset
 *   bun run src/fetch-trades.ts --end 2025-10-30      # stop at a specific day
 *   bun run src/fetch-trades.ts --refresh             # re-download (repopulate
 *                                                     # cache with last-trade)
 */

import { parseArgs } from "util";
import { ALL_VENUES } from "./config.js";
import type { VenueId } from "./types.js";
import { daysInRange } from "./data/trades/aggregate.js";
import { makeVenueSource } from "./data/source.js";
import { setBucketCacheBypass } from "./data/trades/cache.js";

// Earliest trade-dump day per venue (their DOT listing, from the cached-data
// survey). The walk starts here; a too-early start simply 404s on the first
// day(s) and is skipped, so these only need to be approximately right.
const VENUE_START: Record<VenueId, string> = {
  gate: "2020-07-16",
  binance: "2020-08-18",
  kraken: "2020-08-18",
  coinbase: "2021-06-16",
  okx: "2021-09-01",
  bybit: "2022-11-10",
};

function yesterdayUTC(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

function parseVenues(raw: string | undefined): VenueId[] {
  if (!raw || raw === "all") return ALL_VENUES.slice();
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const v of list) {
    if (!ALL_VENUES.includes(v as VenueId)) {
      console.error(`Invalid venue "${v}". Available: ${ALL_VENUES.join(", ")}, or "all".`);
      process.exit(1);
    }
  }
  return list as VenueId[];
}

interface VenueResult {
  venue: VenueId;
  total: number;
  ok: number;
  skipped: string[];
}

async function fetchVenue(venue: VenueId, endDate: string): Promise<VenueResult> {
  const start = VENUE_START[venue];
  if (Date.parse(endDate + "T00:00:00Z") < Date.parse(start + "T00:00:00Z")) {
    console.log(`  [${venue}] skipped — listing day ${start} is after --end ${endDate}`);
    return { venue, total: 0, ok: 0, skipped: [] };
  }
  const days = daysInRange(start, endDate);
  const src = makeVenueSource(venue);
  let ok = 0;
  const skipped: string[] = [];

  console.log(`  [${venue}] ${start} → ${endDate} (${days.length} days)`);
  for (let i = 0; i < days.length; i++) {
    try {
      await src.loadDay(days[i]);
      ok++;
    } catch (e) {
      skipped.push(days[i]);
    }
    if ((i + 1) % 200 === 0) {
      console.log(`  [${venue}] progress ${i + 1}/${days.length} (${ok} ok, ${skipped.length} skipped)`);
    }
  }
  return { venue, total: days.length, ok, skipped };
}

/** Collapse a sorted YYYY-MM-DD list into compact "start..end" run ranges. */
function summariseSkips(days: string[]): string {
  if (days.length === 0) return "none";
  const ranges: string[] = [];
  let runStart = days[0];
  let prev = days[0];
  const nextDay = (d: string) => new Date(Date.parse(d + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
  for (let i = 1; i < days.length; i++) {
    if (days[i] === nextDay(prev)) { prev = days[i]; continue; }
    ranges.push(runStart === prev ? runStart : `${runStart}..${prev}`);
    runStart = prev = days[i];
  }
  ranges.push(runStart === prev ? runStart : `${runStart}..${prev}`);
  return ranges.join(", ");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      venues: { type: "string" },
      end: { type: "string" },
      refresh: { type: "boolean", default: false },
    },
  });

  const venues = parseVenues(values.venues);
  const endDate = values.end ?? yesterdayUTC();
  if (values.refresh) {
    console.log(`--refresh: bypassing the bucket cache — every day will be re-downloaded.`);
    setBucketCacheBypass(true);
  }

  console.log(`\nFetching full trade history for: ${venues.join(", ")} (end ${endDate})`);
  console.log(`Days a venue can't serve are skipped, not fatal.\n`);

  // Each venue runs its days sequentially (per-venue rate limits / month locks);
  // venues run in parallel so the slowest doesn't gate the rest.
  const results = await Promise.all(venues.map((v) => fetchVenue(v, endDate)));

  console.log(`\n══ Summary ══`);
  for (const r of results) {
    console.log(`  ${r.venue.padEnd(9)} ${r.ok}/${r.total} days cached, ${r.skipped.length} skipped`);
    if (r.skipped.length > 0) console.log(`            skipped: ${summariseSkips(r.skipped)}`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

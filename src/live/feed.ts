import type { VenueId } from "../types.js";
import type { FeedSnapshot, FreshTickerPoint, TickerPoint, VenueStatus } from "./types.js";
import { makeLiveAdapter, type LiveVenueAdapter } from "./venues.js";

/** Per-request timeout. Must leave headroom inside the 6s block cadence. */
const FETCH_TIMEOUT_MS = 3_000;

/**
 * The SHARED live fetch layer. One instance per live run; every simulated
 * validator reads from the same per-block snapshot (their diversity comes
 * from per-validator venue subsets + jitter, applied downstream).
 *
 * Failure semantics: a venue that errors or times out keeps its last good
 * points — the staleness clock keeps running, so after the Mini Oracle's 8h
 * cutoff the pipeline itself excludes the venue (matching the design doc).
 */
export class LiveFeed {
  private adapters: LiveVenueAdapter[];
  private lastGood = new Map<VenueId, { points: TickerPoint[]; fetchedAtMs: number }>();
  private lastError = new Map<VenueId, string>();
  /** `${venue}:${pair}` → last observed price + when it last CHANGED. */
  private changeClock = new Map<string, { last: number; lastChangedMs: number }>();

  constructor(venues: VenueId[]) {
    if (venues.length === 0) throw new Error("LiveFeed: need at least one venue");
    this.adapters = venues.map((v) => makeLiveAdapter(v));
  }

  get venues(): VenueId[] {
    return this.adapters.map((a) => a.venue);
  }

  /** Fetch every venue in parallel and assemble the block's snapshot. */
  async poll(): Promise<FeedSnapshot> {
    const nowMs = Date.now();
    await Promise.all(this.adapters.map(async (a) => {
      try {
        const points = await a.fetchTickers(AbortSignal.timeout(FETCH_TIMEOUT_MS));
        this.lastGood.set(a.venue, { points, fetchedAtMs: nowMs });
        this.lastError.delete(a.venue);
      } catch (e) {
        this.lastError.set(a.venue, e instanceof Error ? e.message : String(e));
      }
    }));

    const points: FreshTickerPoint[] = [];
    const venueStatus: Record<string, VenueStatus> = {};
    for (const a of this.adapters) {
      const good = this.lastGood.get(a.venue);
      const err = this.lastError.get(a.venue) ?? null;
      venueStatus[a.venue] = {
        ok: good !== undefined && err === null,
        ageMs: good ? nowMs - good.fetchedAtMs : Infinity,
        lastError: err,
      };
      if (!good) continue;
      for (const p of good.points) {
        const key = `${p.venue}:${p.pair}`;
        const clock = this.changeClock.get(key);
        if (!clock || clock.last !== p.last) {
          this.changeClock.set(key, { last: p.last, lastChangedMs: good.fetchedAtMs });
        }
        points.push({
          ...p,
          fetchedAtMs: good.fetchedAtMs,
          lastChangedMs: this.changeClock.get(key)!.lastChangedMs,
        });
      }
    }
    return { atMs: nowMs, points, venueStatus };
  }
}

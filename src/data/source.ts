import type { CrossVenueSpec, DataSourceSpec, ResolvedPriceSource, VenueId } from "../types.js";
import { fetchCandles } from "./fetcher.js";
import { interpolateToBlocks } from "./interpolator.js";
import { CANDLE_INTERVAL } from "../config.js";
import { combineVenues, daysInRange } from "./trades/aggregate.js";
import { BinanceSpotSource } from "./trades/venues/binance.js";
import { BybitSpotSource } from "./trades/venues/bybit.js";
import { GateSpotSource } from "./trades/venues/gate.js";
import { KrakenSpotSource } from "./trades/venues/kraken.js";
import type { VenueBucket, VenueSpotSource } from "./trades/types.js";

/**
 * Dispatch on data-source kind and return PricePoint[] aligned to the 6s grid.
 *
 * - "candles": existing pipeline, Binance US 1-minute OHLC linearly
 *   interpolated to 6s blocks. Used as the fast-iteration default.
 * - "trades":  per-trade dumps from one or more spot venues, bucketed to 6s
 *   VWAP per venue, then median across venues per block. Preserves
 *   intra-minute volatility and reflects cross-venue price discovery.
 */
export async function loadPriceSource(
  spec: DataSourceSpec,
  startDate: string,
  endDate: string,
): Promise<ResolvedPriceSource> {
  if (spec.kind === "candles") {
    const cacheData = await fetchCandles(startDate, endDate, CANDLE_INTERVAL);
    return { pricePoints: interpolateToBlocks(cacheData.data) };
  }
  return loadTradeSourcePoints(spec.venues, startDate, endDate, spec.crossVenue ?? { kind: "median" });
}

/** Return a venue source instance by id. */
function makeVenueSource(id: VenueId): VenueSpotSource {
  switch (id) {
    case "binance": return new BinanceSpotSource();
    case "bybit":   return new BybitSpotSource();
    case "gate":    return new GateSpotSource();
    case "kraken":  return new KrakenSpotSource();
  }
}

async function loadTradeSourcePoints(
  venues: VenueId[],
  startDate: string,
  endDate: string,
  crossVenue: CrossVenueSpec,
): Promise<ResolvedPriceSource> {
  if (venues.length === 0) {
    throw new Error("loadPriceSource(trades): at least one venue required");
  }
  const days = daysInRange(startDate, endDate);
  console.log(`  Loading trade data: ${venues.join(", ")} × ${days.length} day${days.length === 1 ? "" : "s"} (${startDate} → ${endDate}); cross-venue rule: ${crossVenue.kind}`);

  // Per venue: load all days sequentially (respects per-venue rate limits and
  // any in-flight dedup like Gate's monthly download lock). Across venues:
  // run in parallel so the slowest one (typically Kraken's REST pagination)
  // doesn't block the others.
  const sources = venues.map(makeVenueSource);
  const venueResults = await Promise.all(
    sources.map(async (src) => {
      const dayBuckets: VenueBucket[][] = [];
      for (const date of days) {
        const buckets = await src.loadDay(date);
        dayBuckets.push(buckets);
      }
      const total = dayBuckets.reduce((n, a) => n + a.length, 0);
      const flat: VenueBucket[] = new Array(total);
      let off = 0;
      for (const arr of dayBuckets) {
        for (let i = 0; i < arr.length; i++) flat[off++] = arr[i];
      }
      return [src.id, flat] as const;
    }),
  );

  const perVenue = new Map<VenueId, VenueBucket[]>(venueResults);
  const combined = combineVenues(perVenue, crossVenue);
  // Convert Map to a structuredClone-friendly Record so we can postMessage to workers.
  const venuePrices: Record<VenueId, number[]> = {} as Record<VenueId, number[]>;
  for (const [id, arr] of combined.venuePrices) venuePrices[id] = arr;
  return { pricePoints: combined.points, venuePrices };
}

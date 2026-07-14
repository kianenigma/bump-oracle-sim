import type { FreshTickerPoint, MiniOracleOptions, MiniOracleTrace, TracePoint } from "./types.js";

// ── The Mini Oracle CEX-only pipeline (per "Mini Oracle Design.md") ──────────
// Given a validator's visible ticker points, produce ONE USD price:
//   1. establish a USD index (USDT→USD, USDC→USD) via volume-weighted means
//      of the genuine stable/USD markets,
//   2. normalize every DOT pair to USD,
//   3. drop pairs with < `volumeFloorFrac` of total 24h volume,
//   4. drop pairs stagnant for > `stalenessMaxMs`,
//   5. drop MAD outliers (|p − median| > k·MAD),
//   6. VWAP the survivors (weighted by 24h USD volume).
// Every decision is recorded in the returned trace for the block-detail UI.

/** A trace point plus the staleness clock it is judged against. */
interface WorkPoint extends TracePoint {
  lastChangedMs: number;
}

/** Volume-weighted mean; falls back to plain mean when weights sum to 0. */
function vwMean(values: number[], weights: number[]): number {
  let sum = 0, wSum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] * weights[i];
    wSum += weights[i];
  }
  if (wSum > 0) return sum / wSum;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(sorted: number[]): number {
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

export function computeMiniOracle(
  points: FreshTickerPoint[],
  opts: MiniOracleOptions,
): MiniOracleTrace {
  // ── 1. USD index ──
  const usdtUsdPts = points.filter((p) => p.base === "USDT" && p.quote === "USD");
  const usdtUsd = usdtUsdPts.length > 0
    ? vwMean(usdtUsdPts.map((p) => p.last), usdtUsdPts.map((p) => p.quoteVolume24h))
    : 1.0;

  // USDC→USD: direct USDC/USD markets plus USDC/USDT crossed through the
  // just-computed USDT index.
  const usdcVals: number[] = [];
  const usdcWts: number[] = [];
  for (const p of points) {
    if (p.base !== "USDC") continue;
    if (p.quote === "USD") { usdcVals.push(p.last); usdcWts.push(p.quoteVolume24h); }
    else if (p.quote === "USDT") { usdcVals.push(p.last * usdtUsd); usdcWts.push(p.quoteVolume24h); }
  }
  const usdcUsd = usdcVals.length > 0 ? vwMean(usdcVals, usdcWts) : 1.0;
  const usdIndexAssumed = usdtUsdPts.length === 0 && usdcVals.length === 0;

  const quoteToUsd = (q: FreshTickerPoint["quote"]): number =>
    q === "USD" ? 1.0 : q === "USDT" ? usdtUsd : usdcUsd;

  // ── 2. Normalize DOT points to USD ──
  const work: WorkPoint[] = points
    .filter((p) => p.base === "DOT")
    .map((p) => ({
      venue: p.venue,
      pair: p.pair,
      rawLast: p.last,
      usdPrice: p.last * quoteToUsd(p.quote),
      usdVolume24h: p.quoteVolume24h * quoteToUsd(p.quote),
      dropped: null,
      lastChangedMs: p.lastChangedMs,
    }));

  if (work.length === 0) {
    return { usdtUsd, usdcUsd, usdIndexAssumed, points: [], median: null, mad: null, quote: null };
  }

  // ── 3. Volume floor: drop pairs with < 1% of total 24h volume ──
  const totalVol = work.reduce((a, t) => a + t.usdVolume24h, 0);
  for (const t of work) {
    if (totalVol > 0 && t.usdVolume24h / totalVol < opts.volumeFloorFrac) t.dropped = "volume";
  }

  // ── 4. Staleness: drop pairs whose price hasn't changed in > 8h ──
  for (const t of work) {
    if (t.dropped) continue;
    if (opts.nowMs - t.lastChangedMs > opts.stalenessMaxMs) t.dropped = "stale";
  }

  // ── 5. MAD outlier removal over the survivors ──
  const survivors = work.filter((t) => t.dropped === null);
  let med: number | null = null;
  let mad: number | null = null;
  if (survivors.length > 0) {
    const sorted = survivors.map((t) => t.usdPrice).sort((a, b) => a - b);
    med = median(sorted);
    const m = med;
    const absDevs = survivors.map((t) => Math.abs(t.usdPrice - m)).sort((a, b) => a - b);
    mad = median(absDevs);
    // MAD of 0 (all survivors identical) ⇒ nothing is an outlier.
    if (mad > 0) {
      for (const t of survivors) {
        if (Math.abs(t.usdPrice - m) > opts.madK * mad) t.dropped = "mad";
      }
    }
  }

  // ── 6. Final VWAP ──
  const finals = work.filter((t) => t.dropped === null);
  const quote = finals.length > 0
    ? vwMean(finals.map((t) => t.usdPrice), finals.map((t) => t.usdVolume24h))
    : null;

  const cleanPoints: TracePoint[] = work.map(({ venue, pair, rawLast, usdPrice, usdVolume24h, dropped }) => ({
    venue, pair, rawLast, usdPrice, usdVolume24h, dropped,
  }));

  return { usdtUsd, usdcUsd, usdIndexAssumed, points: cleanPoints, median: med, mad, quote };
}

/**
 * Per-venue representative USD price from a snapshot: the volume-weighted
 * mean of that venue's DOT points, normalized with the GLOBAL USD index
 * (computed over all points). Used for the chart's per-venue lines and the
 * cross-venue reference ("real") price in live mode.
 */
export function venueUsdPrices(
  points: FreshTickerPoint[],
): Map<string, number> {
  // Reuse the pipeline's USD index over the full point set (no filters).
  const full = computeMiniOracle(points, {
    madK: Infinity,
    volumeFloorFrac: 0,
    stalenessMaxMs: Infinity,
    nowMs: Date.now(),
  });
  const byVenue = new Map<string, { vals: number[]; wts: number[] }>();
  for (const tp of full.points) {
    const e = byVenue.get(tp.venue) ?? { vals: [], wts: [] };
    e.vals.push(tp.usdPrice);
    e.wts.push(tp.usdVolume24h);
    byVenue.set(tp.venue, e);
  }
  const out = new Map<string, number>();
  for (const [v, { vals, wts }] of byVenue) out.set(v, vwMean(vals, wts));
  return out;
}

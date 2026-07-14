import type { VenueId } from "../types.js";
import type { BaseAsset, QuoteAsset, TickerPoint } from "./types.js";

// ── Live REST ticker adapters ────────────────────────────────────────────────
// One adapter per venue. Each `fetchTickers` call hits the venue's PUBLIC
// (zero-auth) ticker endpoint(s) once and returns normalized TickerPoints for
// every pair we track there. Per-tick request budget (6s cadence):
//   binance 1 · bybit 3 · okx 3 · kraken 1 · gate 3 · coinbase 3  = 14 req/6s,
// far inside every venue's public rate limit (see LIVE_ORACLE_PLAN.md).

export interface LiveVenueAdapter {
  readonly venue: VenueId;
  /** Fetch the venue's current tickers. Throws on any failure; the feed
   *  catches per-venue and falls back to the last good snapshot. */
  fetchTickers(signal: AbortSignal): Promise<TickerPoint[]>;
}

interface PairSpec {
  /** Venue-native symbol spelling. */
  symbol: string;
  pair: string;
  base: BaseAsset;
  quote: QuoteAsset;
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

function num(v: unknown, what: string): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) throw new Error(`bad numeric field ${what}: ${String(v)}`);
  return n;
}

// ── Binance ── GET /api/v3/ticker/24hr?symbols=[...]  (1 batch call) ─────────

const BINANCE_PAIRS: PairSpec[] = [
  { symbol: "DOTUSDT", pair: "DOT/USDT", base: "DOT", quote: "USDT" },
  { symbol: "DOTUSDC", pair: "DOT/USDC", base: "DOT", quote: "USDC" },
  { symbol: "USDCUSDT", pair: "USDC/USDT", base: "USDC", quote: "USDT" },
];

class BinanceLive implements LiveVenueAdapter {
  readonly venue = "binance" as const;

  async fetchTickers(signal: AbortSignal): Promise<TickerPoint[]> {
    const symbols = encodeURIComponent(JSON.stringify(BINANCE_PAIRS.map((p) => p.symbol)));
    const body = await getJson(`https://api.binance.com/api/v3/ticker/24hr?symbols=${symbols}`, signal);
    if (!Array.isArray(body)) throw new Error("binance: expected array response");
    const bySymbol = new Map<string, Record<string, unknown>>();
    for (const t of body as Array<Record<string, unknown>>) bySymbol.set(String(t.symbol), t);
    return BINANCE_PAIRS.map((spec) => {
      const t = bySymbol.get(spec.symbol);
      if (!t) throw new Error(`binance: missing symbol ${spec.symbol}`);
      return {
        venue: this.venue,
        pair: spec.pair,
        base: spec.base,
        quote: spec.quote,
        last: num(t.lastPrice, "lastPrice"),
        quoteVolume24h: num(t.quoteVolume, "quoteVolume"),
        venueTsMs: typeof t.closeTime === "number" ? t.closeTime : null,
      };
    });
  }
}

// ── Bybit ── GET /v5/market/tickers?category=spot&symbol=  (1 call per pair) ─

const BYBIT_PAIRS: PairSpec[] = [
  { symbol: "DOTUSDT", pair: "DOT/USDT", base: "DOT", quote: "USDT" },
  { symbol: "DOTUSDC", pair: "DOT/USDC", base: "DOT", quote: "USDC" },
  { symbol: "USDCUSDT", pair: "USDC/USDT", base: "USDC", quote: "USDT" },
];

class BybitLive implements LiveVenueAdapter {
  readonly venue = "bybit" as const;

  async fetchTickers(signal: AbortSignal): Promise<TickerPoint[]> {
    const out = await Promise.all(BYBIT_PAIRS.map(async (spec) => {
      const body = await getJson(
        `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${spec.symbol}`, signal,
      ) as { retCode?: number; time?: number; result?: { list?: Array<Record<string, unknown>> } };
      if (body.retCode !== 0) throw new Error(`bybit: retCode ${body.retCode} for ${spec.symbol}`);
      const t = body.result?.list?.[0];
      if (!t) throw new Error(`bybit: empty list for ${spec.symbol}`);
      return {
        venue: this.venue,
        pair: spec.pair,
        base: spec.base,
        quote: spec.quote,
        last: num(t.lastPrice, "lastPrice"),
        quoteVolume24h: num(t.turnover24h, "turnover24h"),
        venueTsMs: typeof body.time === "number" ? body.time : null,
      };
    }));
    return out;
  }
}

// ── OKX ── GET /api/v5/market/ticker?instId=  (1 call per pair) ──────────────

const OKX_PAIRS: PairSpec[] = [
  { symbol: "DOT-USDT", pair: "DOT/USDT", base: "DOT", quote: "USDT" },
  { symbol: "DOT-USDC", pair: "DOT/USDC", base: "DOT", quote: "USDC" },
  { symbol: "USDC-USDT", pair: "USDC/USDT", base: "USDC", quote: "USDT" },
];

class OkxLive implements LiveVenueAdapter {
  readonly venue = "okx" as const;

  async fetchTickers(signal: AbortSignal): Promise<TickerPoint[]> {
    const out = await Promise.all(OKX_PAIRS.map(async (spec) => {
      const body = await getJson(
        `https://www.okx.com/api/v5/market/ticker?instId=${spec.symbol}`, signal,
      ) as { code?: string; data?: Array<Record<string, unknown>> };
      if (body.code !== "0") throw new Error(`okx: code ${body.code} for ${spec.symbol}`);
      const t = body.data?.[0];
      if (!t) throw new Error(`okx: empty data for ${spec.symbol}`);
      return {
        venue: this.venue,
        pair: spec.pair,
        base: spec.base,
        quote: spec.quote,
        last: num(t.last, "last"),
        // For SPOT, volCcy24h is the 24h volume in the QUOTE currency.
        quoteVolume24h: num(t.volCcy24h, "volCcy24h"),
        venueTsMs: t.ts !== undefined ? num(t.ts, "ts") : null,
      };
    }));
    return out;
  }
}

// ── Kraken ── GET /0/public/Ticker?pair=a,b,c  (1 batch call) ────────────────
// Kraken is our genuine USD anchor: it runs real USDT/USD and USDC/USD books.

const KRAKEN_PAIRS: PairSpec[] = [
  { symbol: "DOTUSD", pair: "DOT/USD", base: "DOT", quote: "USD" },
  { symbol: "DOTUSDT", pair: "DOT/USDT", base: "DOT", quote: "USDT" },
  { symbol: "USDTZUSD", pair: "USDT/USD", base: "USDT", quote: "USD" },
  { symbol: "USDCUSD", pair: "USDC/USD", base: "USDC", quote: "USD" },
];

class KrakenLive implements LiveVenueAdapter {
  readonly venue = "kraken" as const;

  async fetchTickers(signal: AbortSignal): Promise<TickerPoint[]> {
    const pairs = KRAKEN_PAIRS.map((p) => p.symbol).join(",");
    const body = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`, signal) as {
      error?: string[];
      result?: Record<string, Record<string, unknown>>;
    };
    if (body.error && body.error.length > 0) throw new Error(`kraken: ${body.error.join(", ")}`);
    if (!body.result) throw new Error("kraken: missing result");

    // Kraken echoes canonical pair names that may differ from what we asked
    // for (e.g. USDCUSD → "USDCUSD", USDTUSD → "USDTZUSD"). Match by stripping
    // the Z/X asset-class prefixes.
    const canon = (s: string) => s.replace(/^X|^Z/, "").replace(/ZUSD$/, "USD").replace(/XXBT/, "BTC");
    const entries = Object.entries(body.result);
    return KRAKEN_PAIRS.map((spec) => {
      const hit = entries.find(([k]) => canon(k) === canon(spec.symbol) || k === spec.symbol);
      if (!hit) throw new Error(`kraken: missing pair ${spec.symbol} in response (${entries.map(([k]) => k).join(",")})`);
      const t = hit[1];
      const c = t.c as unknown[];
      const v = t.v as unknown[];
      const last = num(c?.[0], "c[0]");
      const baseVol24h = num(v?.[1], "v[1]");
      return {
        venue: this.venue,
        pair: spec.pair,
        base: spec.base,
        quote: spec.quote,
        last,
        quoteVolume24h: baseVol24h * last,
        venueTsMs: null,
      };
    });
  }
}

// ── Gate.io ── GET /api/v4/spot/tickers?currency_pair=  (1 call per pair) ────

const GATE_PAIRS: PairSpec[] = [
  { symbol: "DOT_USDT", pair: "DOT/USDT", base: "DOT", quote: "USDT" },
  { symbol: "DOT_USDC", pair: "DOT/USDC", base: "DOT", quote: "USDC" },
  { symbol: "USDC_USDT", pair: "USDC/USDT", base: "USDC", quote: "USDT" },
];

class GateLive implements LiveVenueAdapter {
  readonly venue = "gate" as const;

  async fetchTickers(signal: AbortSignal): Promise<TickerPoint[]> {
    const out = await Promise.all(GATE_PAIRS.map(async (spec) => {
      const body = await getJson(
        `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${spec.symbol}`, signal,
      );
      if (!Array.isArray(body) || body.length === 0) throw new Error(`gate: empty response for ${spec.symbol}`);
      const t = body[0] as Record<string, unknown>;
      return {
        venue: this.venue,
        pair: spec.pair,
        base: spec.base,
        quote: spec.quote,
        last: num(t.last, "last"),
        quoteVolume24h: num(t.quote_volume, "quote_volume"),
        venueTsMs: null,
      };
    }));
    return out;
  }
}

// ── Coinbase ── GET api.exchange.coinbase.com/products/<id>/ticker ───────────
// Coinbase quotes DOT in USD natively — no stablecoin normalization needed.

const COINBASE_PAIRS: PairSpec[] = [
  // Coinbase merged USDC books into USD — there is no separate DOT-USDC product.
  { symbol: "DOT-USD", pair: "DOT/USD", base: "DOT", quote: "USD" },
  { symbol: "USDT-USD", pair: "USDT/USD", base: "USDT", quote: "USD" },
];

class CoinbaseLive implements LiveVenueAdapter {
  readonly venue = "coinbase" as const;

  async fetchTickers(signal: AbortSignal): Promise<TickerPoint[]> {
    const out = await Promise.all(COINBASE_PAIRS.map(async (spec) => {
      const t = await getJson(
        `https://api.exchange.coinbase.com/products/${spec.symbol}/ticker`, signal,
      ) as Record<string, unknown>;
      const last = num(t.price, "price");
      const baseVol24h = num(t.volume, "volume");
      const ts = typeof t.time === "string" ? Date.parse(t.time) : NaN;
      return {
        venue: this.venue,
        pair: spec.pair,
        base: spec.base,
        quote: spec.quote,
        last,
        quoteVolume24h: baseVol24h * last,
        venueTsMs: Number.isFinite(ts) ? ts : null,
      };
    }));
    return out;
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────

const ADAPTERS: Record<string, () => LiveVenueAdapter> = {
  binance: () => new BinanceLive(),
  bybit: () => new BybitLive(),
  okx: () => new OkxLive(),
  kraken: () => new KrakenLive(),
  gate: () => new GateLive(),
  coinbase: () => new CoinbaseLive(),
};

export function makeLiveAdapter(venue: VenueId): LiveVenueAdapter {
  const make = ADAPTERS[venue];
  if (!make) throw new Error(`No live adapter for venue "${venue}"`);
  return make();
}

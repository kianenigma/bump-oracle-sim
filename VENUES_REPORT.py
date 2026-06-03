# ---
# jupyter:
#   jupytext:
#     text_representation:
#       extension: .py
#       format_name: percent
#       format_version: '1.3'
#   kernelspec:
#     display_name: Python 3
#     language: python
#     name: python3
# ---

# %% [markdown]
# # Venue Live-Price API Report
#
# **Goal:** figure out *exactly* what a Polkadot validator would do if it ran this
# oracle in production — query one or more of our six spot venues for a **live**
# price, and (critically) whether it can compute a **volume-weighted average (VWA)**
# across them locally.
#
# Our six venues (pairs as used in `src/data/trades/venues/`):
#
# | Venue | Pair | What our *repo* uses today |
# |-------|------|----------------------------|
# | Binance  | `DOTUSDT` | historical bulk trade dumps (`data.binance.vision`) |
# | Bybit    | `DOTUSDT` | historical bulk trade dumps (`public.bybit.com`) |
# | Coinbase | `DOT-USD` | 1m candle backfill (`api.exchange.coinbase.com`) |
# | Gate     | `DOT_USDT`| historical monthly deals (`download.gatedata.org`) |
# | Kraken   | `DOTUSD`  | REST `/0/public/Trades` pagination |
# | OKX      | `DOT-USDT`| historical daily trade dumps (`okx.com/cdn`) |
#
# Those are *historical* endpoints used to backfill the simulation's ground truth.
# **This report is about the *live* ticker endpoints a validator polls in real time** —
# a different set of URLs. All values below were verified against the live APIs
# (June 2026); re-run the cells to refresh.
#
# This notebook uses **only the Python standard library** (no `pip install`).

# %%
import json
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = {"User-Agent": "oracle-sim-venues-report/1.0"}


def get_json(url, timeout=15):
    """Fetch a URL and parse JSON. Stdlib only."""
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


# %% [markdown]
# ## 1. The live spot-ticker endpoint for each venue
#
# Each venue exposes a **public, unauthenticated REST ticker** returning the last
# trade price plus a 24h-rolling volume. All are a single HTTP GET. We normalise
# each into `{price, base_vol_24h, quote_vol_24h, venue_vwap_24h}`.
#
# `venue_vwap_24h` is the venue's **own server-computed 24h VWAP** — only Binance
# (`weightedAvgPrice`) and Kraken (`p[1]`) hand this to us directly; for the others
# we'd derive it from volume.

# %%
def parse_binance(d):
    # GET /api/v3/ticker/24hr — price + base/quote volume + 24h VWAP, from memory (real-time).
    return dict(price=float(d["lastPrice"]),
                base_vol_24h=float(d["volume"]),
                quote_vol_24h=float(d["quoteVolume"]),
                venue_vwap_24h=float(d["weightedAvgPrice"]))


def parse_bybit(d):
    t = d["result"]["list"][0]
    return dict(price=float(t["lastPrice"]),
                base_vol_24h=float(t["volume24h"]),       # base asset
                quote_vol_24h=float(t["turnover24h"]),    # quote asset
                venue_vwap_24h=None)


def parse_coinbase(d):
    # 'volume' is 24h base-asset volume; no quote volume field on this endpoint.
    return dict(price=float(d["price"]),
                base_vol_24h=float(d["volume"]),
                quote_vol_24h=None,
                venue_vwap_24h=None)


def parse_gate(d):
    t = d[0]
    return dict(price=float(t["last"]),
                base_vol_24h=float(t["base_volume"]),
                quote_vol_24h=float(t["quote_volume"]),
                venue_vwap_24h=None)


def parse_kraken(d):
    t = next(iter(d["result"].values()))   # key is "DOTUSD"
    # c=[last_price, lot_vol]; v=[today, 24h] volume; p=[today, 24h] VWAP.
    return dict(price=float(t["c"][0]),
                base_vol_24h=float(t["v"][1]),
                quote_vol_24h=None,
                venue_vwap_24h=float(t["p"][1]))   # Kraken gives VWAP for free


def parse_okx(d):
    t = d["data"][0]
    return dict(price=float(t["last"]),
                base_vol_24h=float(t["vol24h"]),       # base asset
                quote_vol_24h=float(t["volCcy24h"]),   # quote asset
                venue_vwap_24h=None)


VENUES = {
    "binance":  dict(url="https://api.binance.com/api/v3/ticker/24hr?symbol=DOTUSDT",
                     parse=parse_binance),
    "bybit":    dict(url="https://api.bybit.com/v5/market/tickers?category=spot&symbol=DOTUSDT",
                     parse=parse_bybit),
    "coinbase": dict(url="https://api.exchange.coinbase.com/products/DOT-USD/ticker",
                     parse=parse_coinbase),
    "gate":     dict(url="https://api.gateio.ws/api/v4/spot/tickers?currency_pair=DOT_USDT",
                     parse=parse_gate),
    "kraken":   dict(url="https://api.kraken.com/0/public/Ticker?pair=DOTUSD",
                     parse=parse_kraken),
    "okx":      dict(url="https://www.okx.com/api/v5/market/ticker?instId=DOT-USDT",
                     parse=parse_okx),
}

# %% [markdown]
# **Note on Binance geo-blocking:** `api.binance.com` is blocked from US IPs. A
# US-resident validator would use `https://api.binance.us/api/v3/...` (same schema,
# e.g. `/ticker/price?symbol=DOTUSDT`). All other venues are globally reachable.


# %%
def query_one(name):
    """Query a single venue's live ticker; returns (name, fields, latency_ms, error)."""
    v = VENUES[name]
    t0 = time.perf_counter()
    try:
        fields = v["parse"](get_json(v["url"]))
        return name, fields, (time.perf_counter() - t0) * 1e3, None
    except Exception as e:  # noqa: BLE001 — report any venue failure, don't abort the rest
        return name, None, (time.perf_counter() - t0) * 1e3, repr(e)


# Query all six CONCURRENTLY — this is how a validator would do it.
t0 = time.perf_counter()
with ThreadPoolExecutor(max_workers=len(VENUES)) as ex:
    results = list(ex.map(query_one, VENUES))
wall_ms = (time.perf_counter() - t0) * 1e3

print(f"{'venue':9} {'price':>9} {'base_vol_24h':>15} {'quote_vol_24h':>15} "
      f"{'vwap_24h':>9} {'lat_ms':>7}")
print("-" * 70)
live = {}
for name, f, lat, err in results:
    if err:
        print(f"{name:9} ERROR: {err}")
        continue
    live[name] = f
    vwap = f"{f['venue_vwap_24h']:.4f}" if f["venue_vwap_24h"] is not None else "—"
    qv = f"{f['quote_vol_24h']:,.0f}" if f["quote_vol_24h"] is not None else "—"
    print(f"{name:9} {f['price']:>9.4f} {f['base_vol_24h']:>15,.0f} {qv:>15} "
          f"{vwap:>9} {lat:>7.0f}")
print("-" * 70)
print(f"All {len(VENUES)} venues fetched concurrently in {wall_ms:.0f} ms total wall time.")

# %% [markdown]
# ## 2. Per-venue summary
#
# | Venue | Live ticker endpoint | Live? / update cadence | Volume exposed | True-realtime stream |
# |-------|----------------------|------------------------|----------------|----------------------|
# | **Binance** | `GET api.binance.com/api/v3/ticker/price?symbol=DOTUSDT` (price) · `/ticker/24hr` (price+vol) | Served from memory → effectively last-trade, sub-second. Klines down to **1s**. | `volume` (base) + `quoteVolume` (quote), 24h rolling. Also `weightedAvgPrice` = **24h VWAP**. | WS streams (`@trade`, `@ticker`). Weight: price=2, 24hr=2. |
# | **Bybit** | `GET api.bybit.com/v5/market/tickers?category=spot&symbol=DOTUSDT` | Last-trade, real-time. Klines (`/v5/market/kline`) down to **1m**. | `volume24h` (base) + `turnover24h` (quote). | WS `tickers.*` / `publicTrade.*`. |
# | **Coinbase** | `GET api.exchange.coinbase.com/products/DOT-USD/ticker` | Last-trade snapshot, real-time; docs *recommend* WS over polling. Candles down to **1m** (60s). | `volume` (24h base). No quote-volume on this endpoint. | WS `ticker` / `matches` channels. |
# | **Gate** | `GET api.gateio.ws/api/v4/spot/tickers?currency_pair=DOT_USDT` | Last-trade, real-time. Candlesticks down to **10s**. | `base_volume` + `quote_volume`, 24h. | WS `spot.tickers` / `spot.trades` at `wss://api.gateio.ws/ws/v4/`. |
# | **Kraken** | `GET api.kraken.com/0/public/Ticker?pair=DOTUSD` | Last-trade (`c`), real-time. OHLC down to **1m**. Public limit ~1 req/s. | `v`=volume `[today, 24h]`; **`p`=VWAP `[today, 24h]` server-side**; `t`=trade counts. | WS v2 `ticker` / `trade`. |
# | **OKX** | `GET www.okx.com/api/v5/market/ticker?instId=DOT-USDT` | Last-trade, real-time. Candles down to **1s** (`/market/candles`). Limit 20 req/2s. | `vol24h` (base) + `volCcy24h` (quote). | WS `tickers` / `trades` channels. |
#
# **Takeaways:**
# - Every venue has a **public, keyless, single-GET live price** — no account needed.
# - "Live" = **last trade price**, refreshed continuously (sub-second on the
#   in-memory venues). It is *not* a 15m candle; the slowest native candle is 1m
#   (Bybit/Coinbase/Kraken), and Binance/OKX/Gate go to 1s–10s.
# - **All six expose 24h volume.** Two (Binance, Kraken) even publish a
#   server-side **24h VWAP** directly.

# %% [markdown]
# ## 3. The three production questions
#
# ### Q1 — Can a validator query *one* venue for a live price? ✅ Yes.
# One unauthenticated HTTP GET returns the last trade price. Latency is shown in
# the table above (typically tens–low-hundreds of ms).

# %%
# Demonstrate a single live price query.
name, f, lat, err = query_one("kraken")
print(f"Single-venue query ({name}): price={f['price']:.4f} in {lat:.0f} ms")

# %% [markdown]
# ### Q2 — Can it query *multiple* venues, fast? ✅ Yes, trivially.
# They're independent public endpoints, so a validator fires all requests
# **concurrently**; total latency ≈ the slowest single venue, not the sum.

# %%
t0 = time.perf_counter()
with ThreadPoolExecutor(max_workers=len(VENUES)) as ex:
    multi = {n: r for n, r, _, e in ex.map(query_one, VENUES) if e is None}
print(f"Queried {len(multi)} venues concurrently in "
      f"{(time.perf_counter() - t0) * 1e3:.0f} ms")
print("Last prices:", {n: round(v["price"], 4) for n, v in multi.items()})

# %% [markdown]
# ### Q3 — (critical) Can it compute a VWA across venues *locally*? ✅ Yes — with a caveat.
#
# The validator already holds, per venue, `{last_price, 24h_base_volume}` from the
# tickers above. So it can locally compute any cross-venue aggregate the simulator
# supports — **mean**, **median**, or a **24h-volume-weighted average** — with no
# extra calls. Below we reproduce all three from the live data.

# %%
def mean(xs):
    return sum(xs) / len(xs)


def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


prices = [f["price"] for f in live.values()]
# Volume-weighted average: weight each venue's last price by its 24h base volume.
num = sum(f["price"] * f["base_vol_24h"] for f in live.values())
den = sum(f["base_vol_24h"] for f in live.values())
vwa = num / den

print(f"venues used        : {sorted(live)}")
print(f"cross-venue mean   : {mean(prices):.5f}")
print(f"cross-venue median : {median(prices):.5f}")
print(f"cross-venue VWA    : {vwa:.5f}   (last price weighted by 24h base volume)")

# %% [markdown]
# **The caveat — two different meanings of "VWAP":**
#
# 1. **Cross-venue VWA at an instant** (above): weight each venue's *current* price
#    by its *24h* volume. Fully local, zero extra calls. But the weights are a
#    trailing 24h aggregate, so they shift slowly — fine for "trust busier venues
#    more", not a true instantaneous volume weighting.
#
# 2. **Per-venue short-window VWAP** — what this simulator's ground truth actually
#    uses (6-second per-venue VWAP buckets, see `src/data/trades/aggregate.ts`
#    `bucketizeDay`). The live REST ticker only gives the **last trade price**, not
#    a 6s VWAP. To reproduce the sim's ground truth in production a validator would
#    have to **subscribe to each venue's trades WebSocket and bucket trades into 6s
#    VWAPs locally** — exactly what our backfill does offline. Kraken/Binance only
#    shortcut this to a *24h* VWAP, not a 6s one.
#
# ### Bottom line for the simulation
# - The realistic production model is: each validator polls 1+ venue tickers (keyless,
#   parallel, ~100ms) and gets **last-trade prices**. Computing a cross-venue
#   **mean/median/volume-weighted** price locally is cheap and needs no auth — this
#   maps directly onto our `--cross-venue {mean,median,vwap}` ground-truth rule and a
#   `cross-venue` validator price source.
# - A per-validator **random-venue** view (our default) maps to "each validator
#   happened to poll a different exchange" — captures real cross-venue dispersion.
# - The one thing **not** free over REST is a true **sub-minute VWAP per venue**;
#   that requires consuming the trades WebSocket and bucketing locally. If validators
#   are expected to submit a short-window VWAP rather than a spot last-price, that
#   streaming cost should be modelled explicitly.

# %% [markdown]
# ### Sources (official docs, verified June 2026)
# - Binance Spot — REST market-data endpoints & klines (1s): https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints
# - Bybit v5 — `GET /v5/market/tickers`: https://bybit-exchange.github.io/docs/v5/market/tickers
# - Coinbase Exchange — product ticker: https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductticker
# - Gate v4 — spot tickers & WS `spot.tickers`: https://www.gate.com/docs/developers/apiv4/en/ · https://www.gate.com/docs/developers/apiv4/ws/en/
# - Kraken — public Ticker (`p` = VWAP) & REST rate limits: https://docs.kraken.com/api/docs/rest-api/get-ticker-information · https://docs.kraken.com/api/docs/guides/spot-rest-ratelimits/
# - OKX v5 — market ticker & rate limits: https://www.okx.com/docs-v5/en/

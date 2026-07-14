# Live Oracle Plan — Mini Oracle (CEX-only) on Latched Median

Response to `PROMPT_LIVE.md`: turn the simulator into a **live-running oracle** where
30 validators each run the Mini Oracle CEX-only pipeline every 6-second block, feed
quotes into the **latched-median** aggregator, and the existing chart UI displays the
result in real time — including per-block detail of what every validator submitted.

---

## Part 1 — Live API research (what's actually available)

All endpoints below are **public, zero-auth, free-tier** REST tickers usable in a live
fashion. WebSocket streams exist on every venue too (noted for a future upgrade), but
REST polling at our cadence is one request per venue per 6s block ≈ **0.17 req/s per
venue** — comfortably inside every limit. Verified July 2026.

| Venue | Live ticker endpoint (batch) | Rate limit (public) | DOT pairs | Stable/USD pairs |
|---|---|---|---|---|
| **Binance** | `GET api.binance.com/api/v3/ticker/24hr?symbols=["DOTUSDT","DOTUSDC",...]` | 6 000 weight/min (2–4 w/call) | `DOTUSDT`, `DOTUSDC`, `DOTBTC` | `USDCUSDT` |
| **Bybit** | `GET api.bybit.com/v5/market/tickers?category=spot` (all symbols, 1 call) | 50 req/s | `DOTUSDT`, `DOTUSDC` | `USDCUSDT`, `USDTUSD` (thin) |
| **OKX** | `GET www.okx.com/api/v5/market/tickers?instType=SPOT` (all symbols, 1 call) | 20 req/2 s | `DOT-USDT`, `DOT-USDC` | `USDC-USDT` (USDT/USD deprecated May 2026) |
| **Kraken** | `GET api.kraken.com/0/public/Ticker?pair=DOTUSD,DOTUSDT,USDTZUSD,USDCZUSD` | ~1 req/s sustained | `DOTUSD`, `DOTUSDT`, `DOTEUR` | **`USDTZUSD`, `USDCZUSD`** (genuine USD) |
| **Gate.io** | `GET api.gateio.ws/api/v4/spot/tickers?currency_pair=DOT_USDT` (one per pair) | 200 req/10 s | `DOT_USDT`, `DOT_USDC` | `USDC_USDT` |
| **Coinbase** | `GET api.exchange.coinbase.com/products/DOT-USD/ticker` (one per pair) | 10 req/s | `DOT-USD`, `DOT-USDC`, `DOT-EUR` | quotes **USD natively**; `USDT-USD` |

Ticker responses on every venue carry **last price + 24h quote volume + timestamp** —
exactly the inputs the Mini Oracle pipeline needs.

Notable findings:
- **Kraken and Coinbase are the USD anchors**: Kraken has real `USDT/USD` and
  `USDC/USD` order books; Coinbase quotes DOT directly in USD. Everyone else quotes in
  USDT/USDC, which is why the design's USD-index step matters.
- **Coinbase live is genuine** — the historical limitation (candle-backfilled trades)
  does not apply to live tickers, so coinbase is a first-class live venue.
- **Candidate additions**: **KuCoin** (~$9.4M/24h DOT volume, top-3 venue) and
  **Bitget** are the best candidates if we want >6 venues. MEXC (tier-3 risk), HTX
  (post-rebrand churn), Crypto.com (**exchange winding down**) are rejected. v1 ships
  with the existing 6; the venue adapter interface makes additions one-file changes.
- **WebSocket upgrade path**: every venue offers public trade/ticker streams
  (Binance `<sym>@ticker`, Bybit `tickers.<SYM>`, OKX `tickers` channel, Kraken v2
  `ticker`, Gate `spot.tickers`, Coinbase `ticker`). Worth doing only if we later want
  sub-block latency; polling is simpler and sufficient at 6s blocks.

## Part 2 — Live-mode design

### Topology (shared fetch, diverse views)

One process. One fetch cycle per block. 30 simulated validators share the fetch layer
but each sees a **distinct view** — modelling real-world validator diversity without
30× the API load:

```
every 6s tick:
  LiveFeed ── parallel fetch, 2.5s timeout ──► TickerSnapshot (all venues × pairs)
       │  (venue failure ⇒ keep last snapshot, mark stale)
       ▼
  for each validator v (seeded rng):
      view(v)  = venue subset (4-of-6, rotating) + per-observation jitter
      quote(v) = MiniOracle(snapshot, view(v))     ← full CEX-only pipeline
       ▼
  Chain.nextBlock()  — existing block flow, unchanged:
      gossip quotes → random author → inherent → LatchedMedianAggregator.apply()
       ▼
  LiveBlockRecord — metrics + every submission + per-validator pipeline trace
      → in-memory ring buffer + JSONL on disk
       ▼
  Bun.serve() — same chart UI, live-refreshing; click block → full detail
```

### Mini Oracle pipeline (per validator, per block) — per the design doc

1. **Collect** the validator's visible ticker points: `(venue, pair, lastPrice, vol24h, ts)`.
2. **USD index**: `USDT→USD` = volume-weighted mean of the genuine stable/USD markets
   (Kraken `USDTZUSD`; Bybit `USDTUSD` when fresh); `USDC→USD` = `USDC/USD` markets ×
   cross via `USDC/USDT`. Falls back to 1.0 (flagged in the trace) if no anchor is
   visible.
3. **Normalize** every DOT point to USD: `DOT/USDT × USDT→USD`, `DOT/USDC × USDC→USD`,
   `DOT/USD × 1`.
4. **Volume filter**: drop points with `vol24h(pair) / Σ vol24h < 1%`.
5. **Staleness filter**: drop points whose last price hasn't changed for > 8h
   (tracked per pair by the feed).
6. **MAD outlier filter**: median + Median Absolute Deviation over remaining points;
   drop `|p − median| > k·MAD` (k = 3 default, configurable — the design doc left this
   "to be finalized after simulation", so it's a CLI knob).
7. **Final VWAP** (24h-volume-weighted) over survivors → the validator's quote.

Every step records which points it dropped and why — this **trace** is stored per
validator per block and rendered on the block-detail page.

### Reuse vs new

Reused unchanged: `Chain`, `LatchedMedianAggregator`, `Submission`, `BlockMetrics`,
the chart UI stack (Lightweight Charts, server aggregation for history).
New (all under `src/live/`):

| File | Role |
|---|---|
| `types.ts` | `TickerPoint`, `TickerSnapshot`, `MiniOracleTrace`, `LiveBlockRecord` |
| `venues.ts` | 6 REST adapters: URL builder + response parser → `TickerPoint[]` |
| `feed.ts` | `LiveFeed`: parallel poll w/ timeout, staleness tracking, last-good snapshots |
| `mini-oracle.ts` | the 7-step pipeline + trace |
| `validator.ts` | `LiveHonestValidator implements ValidatorAgent` (quote mode; venue-subset view) |
| `endpoint.ts` | `LivePriceEndpoint extends PriceEndpoint` over growing arrays (reference price = mean of venues' normalized DOT/USD) |
| `run-live.ts` | wall-clock 6s loop, ring buffer (~14 400 blocks = 24h), JSONL persistence |
| `server.ts` | live API: `/api/meta` `/api/data` (same shapes) + `/api/live/tail` + `/api/live/block-detail` |

`viz/template.html` gets a small live branch: when `/api/meta` says `live: true`, poll
the tail endpoint every 3s and `series.update()` the last candle; block click works as
today. The block-detail view renders the full submission list (every validator's quote,
latched-set median) plus each validator's pipeline trace — no CSV needed, it's all in
memory/JSONL.

### CLI

```bash
bun run src/main.ts --live                     # 30 validators, latched-median, all 6 venues, port 3000
bun run src/main.ts --live --validators 30 --venues binance,kraken,okx --port 3000
```

`--live` is a sibling mode to `--analyze-price` (no `--scenario`). Defaults: 30
validators, 100% honest live validators, latched-median, MAD k=3, 4-of-6 venue subsets,
jitter 0.

### Failure semantics

- Venue fetch fails/times out → last-good snapshot used, staleness clock keeps running;
  after 8h the pipeline's own staleness filter excludes it (matching the design doc).
- All venues down → validators abstain (`null` input); latched-median holds the price
  via stale latches — exactly the property latched-median was chosen for.
- Process restart → each run starts a fresh in-memory series; the JSONL is an
  append-only export for offline analysis (reload-on-restart is future work —
  a wall-clock gap breaks the uniform block↔time math the UI assumes).

### Out of scope (v1)

WebSocket transport; KuCoin/Bitget adapters; the RON/aggregator-combined architecture
(doc explicitly scopes to CEX-only); adversarial live validators; multi-asset.

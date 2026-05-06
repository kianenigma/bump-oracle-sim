# Cross-Venue DOT Price Divergence — Historical Windows

A reference of confirmed historical windows during which DOT spot prices
diverged across the venues this simulator ingests. Use these to drive
stress tests of the oracle protocol.

The simulator's per-venue pipeline lives at `src/data/trades/`. As of
2026-05-05 it supports six venues: `binance`, `kraken`, `bybit`, `gate`,
`okx`, `coinbase`. The first five quote `DOT/USDT` (or `DOTUSD` for
Kraken). Coinbase is the only DOT/USD venue with deep liquidity besides
Kraken — relevant for windows where USDT and USD diverge.

---

## Severity legend

| Tag | Meaning |
|---|---|
| **Extreme** | Inter-venue ratio exceeded ~2× during the event. Deep, low-frequency dispersion. |
| **High**    | Sustained 3–10 % gap across venues, or a flash with venue-by-venue lows minutes apart. |
| **Medium**  | Persistent basis or fragmented liquidity, but not catastrophic. |
| **Low**     | Localized to one venue / one asset class (futures, DEX) — not directly useful for a multi-venue spot oracle. |

---

## 1. 2025-10-10 to 2025-10-11 — Tariff cascade (Extreme)

Largest liquidation event in crypto history per Millionero (~$19 B
liquidated in 24 h, analysts later estimated $30–40 B). Triggered by
tariff news. DOT touched **$0.63** on Binance.com main spot but the
Binance.US floor for the same asset stayed near **$3.15** — a 5×
cross-venue ratio. The five non-Coinbase venues are all online; OKX
dump for 2025-10-10 is 561 KB.

Best for: `agreement_gate` and `v_max` stress, ratio-aware aggregator
testing.

```bash
bun run src/main.ts \
  --data-source trades \
  --venues binance,kraken,bybit,gate,okx,coinbase \
  --start-date 2025-10-10 --end-date 2025-10-11 \
  --no-open --output /tmp/oct10.simdata --force
```

This is the existing default for the `aggregator-comparison` scenario.

---

## 2. 2023-03-10 to 2023-03-13 — USDC depeg / SVB (High; sustained)

Silicon Valley Bank failure → Circle's USDC reserves frozen → USDC
fell to **$0.87** for ~48 hours. Effect on DOT pairs:

- DOT/USDT pairs (Binance, Bybit, Gate, OKX, KuCoin) priced DOT in
  *near-par* USDT.
- DOT/USD pairs (Coinbase, Kraken) priced DOT in *full-value* USD.

Result (verified empirically by daily-mean comparison):

| Date | Coinbase USD avg | Binance USDT avg | Gap |
|---|---|---|---|
| 2023-03-10 | 5.4101 | 5.4070 | +0.06 % |
| 2023-03-11 | 5.4633 | 5.4217 | **+0.77 %** |
| 2023-03-12 | 5.5693 | 5.5269 | **+0.77 %** |
| 2023-03-13 | 5.9694 | 5.9418 | +0.46 % |

A modest but **sustained** USD-over-USDT premium for 48 h. (Smaller
than I initially estimated — USDT actually held its peg better than
USDC during this event; the DOT/USDC pair would have shown a larger
gap, but we don't ingest USDC pairs.) Dispersion is **structural,
not a flash** — the only window where the two new venues materially
change the long-horizon picture.

Bulk data confirmed available on every venue (Binance, OKX both ~0.5–
2 MB for those days). Coinbase candles work all the way back.

```bash
bun run src/main.ts \
  --data-source trades \
  --venues binance,kraken,bybit,gate,okx,coinbase \
  --start-date 2023-03-10 --end-date 2023-03-14 \
  --no-open --output /tmp/usdc-depeg.simdata --force
```

Run this with `--cross-venue median` and `--cross-venue vwap` to compare
how the choice of cross-venue rule affects the ground-truth path during
a stablecoin stress event.

---

## 3. 2024-08-05 to 2024-08-06 — Yen carry-trade unwind (High; flash)

BoJ surprise rate hike → yen ripped → carry-trade unwind → Nikkei
−12.4 % in one day → global risk-off. BTC dropped >10 %; some altcoins
"essentially went to zero" momentarily (per Millionero). Cross-venue
divergence is **flash-style**: venues drained at slightly different
speeds within minutes, producing brief deep dislocations in 6 s
windows that smaller venues' order books couldn't absorb.

Bulk data available on all six venues. Binance dump 5.7 MB (large day),
OKX 1.0 MB.

```bash
bun run src/main.ts \
  --data-source trades \
  --venues binance,kraken,bybit,gate,okx,coinbase \
  --start-date 2024-08-05 --end-date 2024-08-07 \
  --no-open --output /tmp/yen-unwind.simdata --force
```

Best for: validator-disagreement testing under `--price-source random-venue`,
because each validator sees a slightly different venue-local low.

---

## 4. 2022-11-08 to 2022-11-11 — FTX collapse (Medium)

FTX's 10-day implosion. DOT was listed on FTX; trading was disrupted
then frozen. Surviving venues drifted apart through cascading user
de-risking; spreads widened as makers pulled liquidity. Less
DOT-specific than the SOL/SRM dispersion of the same period, but a
useful stress narrative.

Bulk data available on all six venues. OKX dump for Nov 9 is 3.7 MB
(peak day).

```bash
bun run src/main.ts \
  --data-source trades \
  --venues binance,kraken,bybit,gate,okx,coinbase \
  --start-date 2022-11-08 --end-date 2022-11-12 \
  --no-open --output /tmp/ftx.simdata --force
```

---

## 5. 2021-05-19 — China crypto crackdown (High; small venue set)

Across-the-board flash crash; DOT swung 30 %+ in minutes across all
liquid venues. Per-venue lows occurred at different timestamps as
order books drained at different rates.

**Caveat:** OKX has no bulk pre-mid-2021 (404). Bybit DOT/USDT spot
pre-dates this date too. Test set is reduced: Binance, Kraken, Gate,
Coinbase.

```bash
bun run src/main.ts \
  --data-source trades \
  --venues binance,kraken,gate,coinbase \
  --start-date 2021-05-18 --end-date 2021-05-20 \
  --no-open --output /tmp/china.simdata --force
```

Binance's DOT/USDT dump for 2021-05-19 is 44 MB — the largest day in our
sample, reflecting the volume spike during the panic.

---

## Summary table

| Window | Event | Severity | Type | Venues with bulk data |
|---|---|---|---|---|
| 2025-10-10 → 11 | Tariff cascade | Extreme | Flash + structural | All 6 |
| 2023-03-10 → 13 | USDC depeg / SVB | High | Sustained (USD/USDT basis) | All 6 |
| 2024-08-05 → 06 | Yen carry unwind | High | Flash | All 6 |
| 2022-11-08 → 11 | FTX collapse | Medium | Liquidity fragmentation | All 6 |
| 2021-05-19 | China crackdown | High | Flash | Binance, Kraken, Gate, Coinbase only |

---

## Excluded events (for completeness)

- **2026-04-13 — Hyperbridge exploit.** DOT briefly crashed 5 % on a
  Uniswap V4 pool after $20 M of fake DOT was minted on Ethereum. CEX
  impact was muted — primarily a DEX-side event. Not relevant for our
  multi-CEX simulation.
- **2021 Binance COIN-margined DOT futures flash crash ($33 → $0.20).**
  Single-stop-order incident isolated to that one futures product;
  spot pricing on every venue (including Binance spot) was unaffected.
  This simulator models spot only.

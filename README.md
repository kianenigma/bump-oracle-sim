# Oracle Bump Simulation

Simulates an oracle price-aggregation mechanism where a set of validators submit inputs each block and the chain combines them into an oracle price that tries to track a real price (DOT/USDT). Real price comes from per-trade multi-venue data (default), historical Binance candles, or a deterministic synthetic path. The simulation runs block-by-block, writes results to a chunked `.simdata` directory, then serves an interactive chart.

> **Runtime: [Bun](https://bun.sh/), not Node.js.** All commands use `bun`.
>
> For architecture and internals, see [`CLAUDE.md`](./CLAUDE.md).

## Prerequisites

- [Bun](https://bun.sh/) runtime

```bash
bun install
```

There are no runtime dependencies — only `@types/bun` and `typescript` as devDependencies.

## Quick Start

A simulation is always driven by a **named scenario** — `--scenario` is required (there is no ad-hoc single-sim path).

```bash
# Run the honest baseline, write .simdata, serve the chart, open the browser
bun run src/main.ts --scenario honest

# List every available scenario
bun run src/main.ts --list-scenarios

# Quick iteration: few validators, a few days of data
bun run src/main.ts --scenario honest --validators 30 --start-date 2024-01-01 --end-date 2024-01-04

# Serve an existing result without re-running the simulation
bun run src/main.ts --data honest_2024-01-01_2024-01-04.simdata
```

Output goes to a directory named `<scenario>_<start>_<end>.simdata` unless `--output` is given.

> A year of data is ~5.2M blocks per simulation and takes minutes to run. For quick iteration, use ~30 validators and a few days of data.

## Data Sources

Select with `--data-source` (default `trades`):

| Source | What it is |
|--------|-----------|
| `trades` *(default)* | Per-trade dumps from up to 6 spot venues (binance, kraken, bybit, gate, okx, coinbase), bucketed to 6s VWAP per venue, then combined via `--cross-venue` (mean/median/vwap) into the ground truth. Yields per-venue price/volume series. |
| `candles` | Binance US 1m OHLC, linearly interpolated to 6s blocks. Fast to iterate on. |
| `synthetic` | Deterministic 24-event scripted price path. No real dates — `--start-date`/`--end-date` are rejected. |

How each validator *observes* the price is set by `--validator-price-source`:
- `random-venue` (default for trades) — each query reads a random venue.
- `cross-venue` (default for candles) — each query reads the combined ground truth.

`--jitter` adds Gaussian noise (as a fraction of price) on top of the observation; default `0` (no jitter).

## Pre-fetch Data

Downloads price data into a local cache so subsequent runs skip the network. Re-running is incremental.

```bash
bun run src/fetch-all.ts                 # pre-fetch the full candle history
bun run src/main.ts --scenario honest --fetch-only   # fetch/generate only for one scenario's config
```

## CLI Reference

```
bun run src/main.ts [options]

Options:
  --scenario <name>            REQUIRED to simulate. See --list-scenarios.
  --analyze-price              Inter-venue spread analysis instead of a simulation
                               (trades only; coinbase auto-excluded). Defaults to the
                               full all-venue window; hard-fails on missing data. See below.
  --refresh-last-trade         With --analyze-price: bypass the bucket cache and re-fetch so
                               days get genuine last-trade prices (slow). See below.
  --start-date <YYYY-MM-DD>    Start date (default: 2025-01-01)
  --end-date <YYYY-MM-DD>      End date (default: 2025-01-07)
  --validators <number>        Number of validators (default: 300)
  --seed <number>              Random seed (default: 42)
  --jitter <fraction>          Per-observation jitter std dev as a fraction (default: 0)
  --convergence-threshold <%>  Convergence threshold in % (default: 0.5)
  --output <path>              Output directory (default: <scenario>_<start>_<end>.simdata)
  --force                      Overwrite an existing output directory
  --threads <number>           Worker threads for batch scenarios (default: CPU count)

  --data-source <kind>         "trades" (default), "candles", or "synthetic"
  --venues <list|all>          Comma-separated venue ids, or "all" (default).
                               Venues: binance, kraken, bybit, gate, okx, coinbase
  --cross-venue <rule>         Combine per-venue prices into the ground truth:
                               "mean" (default), "median", "vwap" (trades only)
  --validator-price-source <mode>
                               "random-venue" (default for trades) or "cross-venue"
                               (default for candles)
  --synthetic-venue-jitter <f> Per-venue jitter for synthetic mode (default: 0.001)
  --synthetic-move-blocks <l>  Comma-separated move-phase schedule for synthetic mode (default: "10")

  --data <path>                Serve an existing .simdata directory without re-running
  --label <substring>          Filter scenarios by label substring (use with --data)
  --index <N>                  Filter to a single scenario by index (use with --data)
  --from <YYYY-MM-DD>          View window start (use with --data)
  --to <YYYY-MM-DD>            View window end (use with --data)
  --reanalyze                  Re-run scoring/report on existing --data (no re-simulation)

  --fetch-only                 Only fetch/generate price data, don't simulate
  --list-scenarios             List available scenario names
  --port <number>              Server port (default: 3000)
  --no-open                    Don't auto-open the browser
  --help                       Show help
```

Some scenarios pin their own date range (see `SCENARIO_DATE_RANGES` in `src/analysis/scenarios.ts`) and override `--start-date`/`--end-date`.

## Scenarios

Each scenario emits a batch of `SimulationConfig`s with canonical labels (`<engine> | <mix> [suffix]`) and runs them via a Bun Worker pool. List the current set with `--list-scenarios`.

| Name | What it sweeps |
|------|----------------|
| `honest` | 100% honest baseline across nudge (1× and 2× default ε) and median |
| `entire-venue-history` | Honest baseline (nudge + median) over the full window all venues have trade data |
| `nudge-velocity` | Fixed-ε nudge vs. velocity-boosted nudge, under 0/10/33/49% pushy-max |
| `sweep-malicious` | Malicious fraction 0 → 50% on the default aggregator |
| `sweep-all-malicious` | Every adversary type × {10, 20, 33}% on the default aggregator |
| `sweep-malicious-and-epsilon` | Malicious fraction × {⅕×, 1×, 5×} default ε (nudge) |
| `sweep-pushy-and-epsilon` | Pushy fraction × {⅕×, 1×, 5×} default ε (nudge) |
| `epsilon-sweep` | ε ∈ {0.25, 0.5, 1, 2, 4}× default, 100% honest (nudge) |
| `min-epsilon` | Smallest nudge ε that tracks DOT within 0.5% over its history since 2023 (all honest, no jitter) |
| `edge-malicious` | {49, 50}% of each adversary type on the default aggregator |
| `research-absolute-eps` | Grid: absolute-ε multipliers × adversary mixes, with scoring report |
| `research-ratio-eps` | Grid: ratio-ε multipliers × adversary mixes, with scoring report |
| `research-ratio-eps-all-honest` | Ratio-ε grid, honest only, with scoring report |
| `latched-median` | latched-median vs. median under 0/10/33/49% pushy-max |
| `aggregator-comparison` | nudge vs. median vs. latched-median under pushy-max / noop |

## Price Analysis (`--analyze-price`)

A subcommand that runs **no oracle simulation**. Instead it asks: across the
venues, how far apart is the live spot price, historically? For each 6s block it
takes every venue's **last-trade** price (the closest analog to a validator
reading a live ticker) and measures the **inter-venue spread**
`(max − min) / reference`, for reference ∈ {mean, median, vwap}.

```bash
# Longest complete window across all venues (the default — omit the dates):
bun run src/main.ts --analyze-price

# A specific window
bun run src/main.ts --analyze-price --start-date 2024-01-01 --end-date 2024-06-30

# Force genuine last-trade prices for days cached before the field existed
# (re-downloads the whole range — slow):
bun run src/main.ts --analyze-price --refresh-last-trade

# Re-serve an existing analysis without recomputing
bun run src/main.ts --data price-analysis_2022-11-10_2025-10-30.simdata
```

With no `--start-date`/`--end-date`, it defaults to the full all-venue window
(`2022-11-10 → 2025-10-30`) — the longest span where every venue has complete,
gap-free trade data. The command **hard-fails if any venue is missing trade data
for any day** in the range (rather than silently padding with carry-forward), so
narrow the range or drop a venue if it complains.

It prints, for each reference, the **% of time / duration** the spread sat in
each band (`< 0.5%`, `0.5–1%`, `1–5%`, `≥ 5%`) plus grouped **episode lists**
(start, duration, peak, which venues were high/low) for the elevated bands, and
writes a full `price_analysis.json`. Since spread is a conservative upper bound
on any single venue's error vs the mean, "spread < 0.5% for X% of blocks" is
direct evidence that using one venue's spot price (or the mean) stays within
0.5% of consensus that often.

Requires `--data-source=trades`. **Coinbase is auto-excluded** — our Coinbase
history is backfilled from 1m candles, so it has no genuine 6s last-trade; the
other five venues use real per-trade data.

## Aggregators

The aggregator is chosen per-config inside each scenario (it is not a CLI flag).

- **nudge** — validators emit signed `Up`/`Down` bumps; `price' = lastPrice + (Σ activated bumps) × ε`. The only mode that uses ε.
- **median** — validators submit absolute price quotes; `price' = median(quotes)`. Requires a quorum (`minInputs`, default `floor(2/3·N)+1`, Polkadot's 2/3-honest assumption).
- **latched-median** — like median but with no quorum; each validator's last quote is *latched*, and the median is taken over the full latched set each block (including stale latches of absent validators). Currently wired for `honest` + `pushy-max`.

### Epsilon (nudge only)

The project default ε is **ratio-based**: `0.01 / N` per bump — i.e. a 1% oracle move when all N validators agree on a direction in a single block. Scenarios sweep it via a multiplier (e.g. `2×` or `⅕×` the default). Epsilon can also be an absolute step or `"auto"` (`maxBlockDelta / N`).

## Adversary Types

Honest is the auto-derived remainder of any validator mix. Each adversary class declares which aggregators it's compatible with; the engine throws on an incompatible pairing.

| Type | Behavior |
|------|----------|
| `malicious` | Inverse strategy — pushes price *away* from the real price |
| `pushy` | Honest direction but overshoots past the real price |
| `pushy-max` | *(nudge only)* Picks whichever bump direction maximizes divergence |
| `noop` | Author-side censorship — drops the inherent, freezing the oracle |
| `delayed` | Honest intent, but reads an observation `delayBlocks` (default 10 ≈ 60s) ago |
| `drift` | Persistent upward bias regardless of the real price |

## Research Scenarios

The `research-*` scenarios run a grid search over epsilon × adversary mixes, score every run, and write a `research_report.json` alongside the `.simdata` (plus a ranking table to stdout).

Each run is scored on a weighted combination of metrics (max deviation, convergence rate, deviation integral, mean deviation, recovery, p95/p99 tails). Epsilons are then ranked by a composite of baseline performance and resilience under attack. The exact weights, thresholds, and formula live in `src/analysis/research-criteria.ts` and `research-report.ts`.

All weights and thresholds are overridable via environment variables:

```bash
WEIGHT_MAX_DEVIATION=0.8 WEIGHT_CONVERGENCE=0.3 WEIGHT_INTEGRAL=0.3 \
WEIGHT_MEAN_DEVIATION=0.1 WEIGHT_RESILIENCE=0.5 \
MAX_ACCEPTABLE_DEVIATION=10 CONVERGENCE_THRESHOLD=0.1 \
bun run src/main.ts --scenario research-ratio-eps --no-open
```

After a run, you can re-score instantly (no re-simulation) with different criteria:

```bash
WEIGHT_RESILIENCE=0.8 bun run src/main.ts --data research-ratio-eps_2025-01-01_2025-01-07.simdata --reanalyze
```

## Multi-threading

Batch scenarios (any scenario with multiple simulations) parallelize across Bun Workers automatically.

- Default thread count: number of CPU cores; override with `--threads <N>`.
- Single simulations always run on the main thread.
- Progress shows as a live per-worker + overall ANSI display.
- **Velocity-enabled scenarios force single-threaded** — velocity policies are functions and don't survive worker `postMessage`.

## `.simdata` Output

`.simdata` is a **directory**, not a single file:

```
<scenario>_<start>_<end>.simdata/
  index.json        per-scenario config + summary + chunk ranges
  venues.json       (trades only) per-venue price/volume series
  events.json       (synthetic only) per-event spans for chart labels
  <slug>_<i>/       columnar block chunks (≤ 1M blocks each)
  <slug>_<i>.csv    per-block CSV (author, inherent composition, votes, prices)
```

## Visualization

The default mode starts a local server and opens an interactive chart:

- Candlestick/line toggle for price and oracle series
- Timeframe selection (6s to 1w) with on-demand data loading (zoom for finer resolution)
- Per-series visibility toggles, collapsible stats panel
- Drag-to-zoom; keyboard shortcuts (arrows to pan, +/- to zoom, R to reset)
- **Click any block** to open a per-block detail page listing the full inherent vote breakdown for each scenario

## Quality Gates

```bash
npx tsc --noEmit                    # type check — the primary quality gate
bun test tests/aggregator.test.ts   # per-block aggregator behaviour tests
```

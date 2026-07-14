# Oracle Bump Simulation

## Project Overview

Simulates an oracle price-aggregation mechanism where a set of validators submit
inputs each block and the chain combines them into an oracle price that tries to
track a real price (DOT/USDT). Real price comes from historical Binance candles,
per-trade multi-venue data, or a deterministic synthetic path. The simulation
runs block-by-block, writes results to a chunked `.simdata` directory, then
serves an interactive chart.

**Runtime**: Bun (NOT Node.js). Use `bun run src/main.ts` (or `bun run sim`).

## Commands

```bash
bun run src/main.ts --scenario honest   # run a scenario, write .simdata, serve, open browser
bun run src/main.ts --live              # LIVE oracle: real-time Mini Oracle + latched-median (see below)
bun run src/fetch-trades.ts             # bulk-download ALL venues' full trade history into the cache
npx tsc --noEmit                         # type check — the primary quality gate
bun test tests/aggregator.test.ts        # per-block aggregator behaviour tests
```

No runtime dependencies — only `@types/bun` and `typescript` as devDependencies.

## Architecture

```
src/
  main.ts              CLI entry point (parseArgs). --scenario is REQUIRED to simulate.
  types.ts             All type definitions (aggregators, validators, submissions, .simdata)
  config.ts            Defaults + constants (BLOCK_TIME_SECONDS=6, ALL_VENUES, DEFAULT_CONFIG)
  rng.ts               Seeded PRNG (mulberry32) + Gaussian RNG
  validators.ts        buildValidators (GroupSpec[] → ValidatorGroup[]), compatibility, formatting
  mix.ts               DEPRECATED placeholder (no exports; kept pending deletion approval)
  fetch-all.ts         Standalone candle pre-fetch script (Binance 1m → candle cache)
  fetch-trades.ts      Standalone per-venue trade pre-fetch: each venue's FULL
                       listing→yesterday history into the bucket cache; skips
                       (never fatals on) days a venue can't serve
  data/
    source.ts          loadPriceSource: dispatches candles / trades / synthetic → ResolvedPriceSource
    fetcher.ts         Binance US candle API client (with retry)
    cache.ts           Disk cache for fetched candle data
    interpolator.ts    Linear interpolation from 1m candles to 6s blocks; maxBlockDelta
    synthetic.ts       Deterministic scripted price path (24-event sequence, multi-duration)
    trades/            Per-trade multi-venue pipeline (6 venues → 6s VWAP buckets)
      aggregate.ts     combineVenues (mean/median/vwap), daysInRange
      cache.ts, gunzip.ts, types.ts
      venues/          binance, bybit, coinbase, gate, kraken, okx spot sources
  sim/
    engine.ts          Orchestrator: resolves config, builds validators+aggregator, runs, summarizes
    chain.ts           Block-by-block flow (gather inputs → pick author → inherent → aggregate)
    aggregator.ts      NudgeAggregator + MedianAggregator + makeAggregator factory
    validator.ts       ValidatorAgent interface, ProduceCtx, InputKind, HonestValidator
    malicious.ts       MaliciousValidator, PushyMaliciousValidator, MaximallyPushyValidator,
                       NoopValidator, DelayedValidator, DriftValidator
    registry.ts        VALIDATOR_REGISTRY: type-string → constructor (single source of truth)
    price-endpoint.ts  Wraps price data; per-validator jitter; per-venue lookup
    worker.ts          Bun Worker entry point for the parallel scenario pool
  analysis/
    scenarios.ts       Named scenario runners + runBatch (worker pool) + label formatting
    research-criteria.ts  Scoring weights/thresholds (.env-overridable)
    research-report.ts    Formatted research report (stdout + research_report.json)
    scoring-functions.ts  Scoring primitives used by the report
  live/
    types.ts           TickerPoint/FeedSnapshot/MiniOracleTrace/LiveBlockRecord
    venues.ts          Public REST ticker adapters (all 6 venues; zero-auth, batch where possible)
    feed.ts            LiveFeed: one parallel poll per 6s block, timeout, last-good fallback,
                       per-pair price-change clock (feeds the 8h staleness filter)
    mini-oracle.ts     The CEX-only pipeline: USD index (Kraken USDT/USD + USDC/USD anchors) →
                       volume floor (1%) → staleness (8h) → MAD outliers (k=3) → VWAP; full trace
    validator.ts       LiveHonestValidator (quote mode; per-validator venue subset + jitter)
    store.ts           Growing columnar series + slim per-block records (JSONL) + trace ring
    run-live.ts        Wall-clock 6s loop reusing Chain + LatchedMedianAggregator verbatim
    server.ts          Live chart server: same /api/* shapes from memory + live block detail
  viz/
    server.ts          Bun.serve(): /api/meta, /api/data, /api/block, /api/block-detail; /block page; LRU chunk cache; author replay
    aggregation.ts     Server-side OHLC/line/deviation/volume aggregation via binary search
    writer.ts          ChunkWriter (.simdata chunks) + CsvWriter + index/venues/events files
    template.html      Chart viewer (server-fetch mode); click a block → /block detail page
    block.html         Standalone per-block detail page (all scenarios; active ones expanded)
    UI_RULES.md        Chart UI conventions
```

There is no `chart.ts` / `--export-html` anymore — the self-contained HTML export
was removed; `template.html` is server-only and fetches from the API.

## CLI

`--scenario <name>` is **required** to run a simulation (no ad-hoc single sims).
Output goes to a directory named `<scenario>_<start>_<end>.simdata` unless
`--output` is given.

```bash
bun run src/main.ts --scenario honest                 # simulate → .simdata → serve → open
bun run src/main.ts --data path.simdata               # serve an existing .simdata (no re-run)
bun run src/main.ts --reanalyze --data path.simdata   # re-run scoring/report only
bun run src/main.ts --scenario honest --fetch-only     # fetch/generate price data only
bun run src/main.ts --analyze-price                    # inter-venue spread analysis (no sim)
bun run src/main.ts --list-scenarios                   # print scenario names
bun run src/main.ts --help                             # full flag list
```

### `--analyze-price` subcommand (no oracle simulation)

Measures the **inter-venue spread** of the live (last-trade) spot price across
venues — `(max − min) / reference` per 6s block, for reference ∈ {mean, median,
vwap} — over the requested history. Answers "how far apart are the venues, i.e.
what's the cost of trusting just one venue's spot price." Requires
`--data-source=trades`; **coinbase is auto-excluded** (candle-backfilled, no
genuine 6s last-trade). Prints band tables (% of time + duration in
<0.5% / 0.5–1% / 1–5% / ≥5%) plus grouped episode lists for the elevated bands,
writes `price_analysis.json`, and serves a per-venue + divergence chart
(`viz/price-analysis.html`). Implementation: `analysis/price-analysis.ts`
(spread/band/episode pass) + the `lastTrade` reduction in
`data/trades/aggregate.ts` (`combineVenues(perVenue, spec, "lastTrade")`).

- **Default range**: when `--start-date`/`--end-date` are omitted it uses
  `ENTIRE_VENUES_HISTORY` (`2022-11-10 → 2025-10-30`, exported from
  `analysis/scenarios.ts`) — the full window where all venues have complete,
  gap-free trade data.
- **Hard-fails on missing data**: `assertFullVenueCoverage` throws if any venue
  has a UTC day with zero trades in the range (a missing dump 404s at the source
  even earlier). It refuses to analyze partial/carry-forward-padded data.
- `--refresh-last-trade`: bypasses the bucket cache (`setBucketCacheBypass` in
  `data/trades/cache.ts`) so days cached before the `lastTrade` field are
  re-downloaded/re-bucketized with genuine last-trade prices. Slow (re-fetches
  the whole range); the cache is repopulated afterwards.

### `--live` subcommand (real-time Mini Oracle)

Runs the oracle LIVE instead of over history (design + API research:
`LIVE_ORACLE_PLAN.md`; validator internals: `Mini Oracle Design.md`). Every 6s
wall-clock block:

1. A **shared fetch layer** (`live/feed.ts`) polls each venue's public REST
   ticker once (~14 req per block across 6 venues — far inside all rate
   limits). A failing venue keeps its last-good points; the staleness clock
   keeps running.
2. Each of the (default 30) validators runs the **Mini Oracle CEX-only
   pipeline** over its own deterministic 4-venue subset: USD-normalize via the
   stable/USD index (Kraken `USDTZUSD`/`USDCUSD` are the genuine anchors;
   Coinbase quotes USD natively), 1% volume floor, 8h staleness filter, MAD
   outlier removal (`--mad-k`, default 3), final volume-weighted VWAP.
3. The unchanged `Chain` + `LatchedMedianAggregator` consume the quotes.
4. The block is recorded (slim record for every block → `live_blocks.jsonl`;
   full per-validator pipeline traces kept for the last ~3000 blocks) and the
   standard chart UI follows the tail (template polls `/api/meta` on the block
   cadence). Clicking a block shows per-venue health + every validator's
   quote, venue subset, and expandable pipeline trace.

Flags: `--validators` (default 30 in live mode), `--venues`, `--seed`,
`--jitter`, `--mad-k`, `--live-subset` (venues per validator, default 4),
`--port`, `--no-open`, `--output` (default `live_<date>/`).

Live-only notes: Coinbase has **no DOT-USDC product** (USDC books merged into
USD); OKX's USDT/USD pair is deprecated (May 2026) — USD conversion leans on
Kraken. Candidate venue additions (KuCoin, Bitget) are surveyed in
`LIVE_ORACLE_PLAN.md`.

### Key flags

- `--scenario <name>` — required to simulate (see scenario list below).
- `--start-date` / `--end-date` (YYYY-MM-DD). Some scenarios pin their own range
  (see `SCENARIO_DATE_RANGES`) and override these.
- `--validators <N>` (default 300), `--seed`, `--jitter`, `--convergence-threshold`.
- `--threads <N>` — Bun Worker pool size for batch scenarios (default CPU count).
- `--csv` — also write the per-block `<scenario>.csv` (off by default; large).
  Required for the block-detail page's full inherent vote list.
- `--force` — overwrite an existing output directory.
- `--data-source <candles|trades|synthetic>` (default `trades`).
- `--venues <list|all>` — trade/synthetic venues (binance, kraken, bybit, gate, okx, coinbase).
- `--cross-venue <mean|median|vwap>` — how per-venue prices combine into the ground truth (default mean).
- `--validator-price-source <random-venue|cross-venue>` — how each validator observes price
  (default random-venue for trades, cross-venue for candles).
- `--synthetic-venue-jitter`, `--synthetic-move-blocks <list>` — synthetic-mode knobs.
- `--data <dir>` + `--label <substr>` / `--index <N>` / `--from` / `--to` — serve/filter existing results.
- `--no-open`, `--port <N>`.

## Simulation Mechanics

### Per-block flow (`chain.ts`)
1. Every validator produces one `Submission` (`produceInput`) or abstains (`null`).
2. A block author is chosen uniformly from **all** validators.
3. Author selects which inputs go into the **inherent** (`produceInherent`) — this
   models author-side censorship; the aggregator only ever sees the inherent.
4. `aggregator.onBeforeApply` finalizes per-block state (nudge velocity gate).
5. `aggregator.apply(inherent)` computes the new oracle price.
6. `aggregator.onBlockEnd` updates per-run state (nudge velocity proposal).
7. Deviation vs. real price is recorded.

### Aggregators (`aggregator.ts`)
- **nudge**: validators emit signed `Up`/`Down` bumps; `price' = lastPrice + (Σ activated bumps) × ε`.
  Only mode that uses ε. `minInputs` defaults to 0.
- **median**: validators submit absolute price quotes; `price' = median(inherent quotes)`.
  `minInputs` defaults to `floor(2/3·N) + 1` (Polkadot's 2/3-honest assumption protects the median).
- **latched-median**: like median but **no minInputs**, and per-validator quotes are
  *latched*. The aggregator keeps each validator's last submitted quote; each block the
  inherent refreshes the latches of the validators it contains, then the median is taken
  over the **full latched set** (including stale latches of absent validators). Wired for
  `honest` + `pushy-max` only so far (other validators are incompatible and throw).

`AggregatorConfig` lives on `SimulationConfig.aggregator`; the engine resolves
`"auto"`/ratio epsilon and default `minInputs` before instantiating.

### Epsilon (`EpsilonSpec`)
- `number` — absolute step.
- `"auto"` — `maxBlockDelta / validatorCount`.
- `{ ratio }` — per-bump fraction of current price (`effective = lastPrice · ratio`).
- **Default project ε is ratio-based**: `0.01 / N` per bump, i.e. 1% oracle move
  when all N validators agree on a direction in one block. Scenarios sweep it via
  `ratioEpsilon(N, multiplier)`.

### Velocity (nudge only, scenario-file feature, not CLI-wired)
Optional `VelocityConfig` (up/down policies) lets ε boost by a coefficient when
agreement is high. Non-compounding: each block lands on `baseEpsilon` or
`baseEpsilon × coefficient`. Gated by the author opting in (`wantVelocityBoost`),
a direction match, and `agreementGate(rate)`. Velocity policies are functions, so
they can't be structured-cloned to workers — `runBatch` forces single-threaded
when any config uses velocity.

### Validators (`registry.ts`)
`honest`, `malicious` (inverse/away from real), `pushy` (overshoot past real),
`pushy-max` (nudge-only; picks the bump direction maximizing divergence), `noop`
(author-side censorship — empty inherent freezes the chain), `delayed` (reads a
stale observation `delayBlocks` ago), `drift` (persistent upward bias). Each class
declares a `static readonly compatibleEngines`; the engine throws on an
incompatible (validator, aggregator) pairing. Per-type knobs are in
`ValidatorParams` (defaults in `config.ts`).

Validators are configured as `ValidatorGroup[]` — each group is a
`(type, count, priceSource, params)` tuple; honest is the auto-derived remainder.
Build them with `buildValidators(total, GroupSpec[], priceSource)`.

> Note: `ValidatorParams.withholderDirection` and a "withholder" type are
> referenced in comments/types but **not yet** in the registry.

## Scenarios (`analysis/scenarios.ts`)

`honest`, `entire-venue-history`, `nudge-velocity`, `sweep-malicious`,
`sweep-all-malicious`, `sweep-malicious-and-epsilon`, `sweep-pushy-and-epsilon`,
`epsilon-sweep`, `edge-malicious`, `research-absolute-eps`, `research-ratio-eps`,
`research-ratio-eps-all-honest`, `latched-median`, `aggregator-comparison`.

Each scenario emits a batch of `SimulationConfig`s with canonical labels
(`<engine> | <mix> [suffix]`) and runs them via `runBatch`, which uses a Bun
Worker pool (`sim/worker.ts`) when `threadCount > 1` and there is more than one
config. The `research-*` scenarios additionally write `research_report.json`.

## Data Sources (`data/source.ts`)

- **candles**: Binance US 1m OHLC, linearly interpolated to 6s blocks (fast iteration).
- **trades**: per-trade dumps from 1+ spot venues, bucketed to 6s VWAP per venue,
  then combined via `crossVenue` (mean/median/vwap). Yields per-venue price and
  volume arrays alongside the combined ground truth. This is the **default**.
- **synthetic**: deterministic 24-event scripted path (no real dates;
  `--start-date`/`--end-date` are rejected). `--synthetic-move-blocks` is a
  *schedule* — each entry runs one 24-event pass at that move-duration.

## `.simdata` — Chunked Directory Format

`.simdata` is a **directory**, not a single file (the old monolithic columnar
JSON is gone). Layout:

```
<scenario>_<start>_<end>.simdata/
  index.json              SimDataIndex: per-scenario config + summary + chunk ranges + dir name
  venues.json             (trades only) per-venue price/volume arrays, shared across scenarios
  events.json             (synthetic only) per-event span list for chart labelling
  <slug>_<i>/             one dir per scenario
    blocks_0.json         BlockChunk (≤ 1M blocks each, columnar, stream-written)
    blocks_1.json
  <slug>_<i>.csv          per-block CSV (CsvWriter): author, inherent composition, votes, prices
                          — written ONLY when `--csv` is passed (off by default; large)
```

A `BlockChunk` carries columnar arrays: `timestamps`, `realPrices`,
`oraclePrices`, `deviationPcts`, plus optional `priceUpdated`, `inherentTotals`,
`medianValidatorIndices`, `agreementRates`, `epsilonCoefficients` (lazily tracked;
absent fields default sensibly for backward compat). `BLOCKS_PER_CHUNK = 1_000_000`.

## Server API (`viz/server.ts`)

- `GET /api/meta` — scenario list (config + summary + time range).
- `GET /api/data` — returns **both** OHLC and line data (so candle/line toggles
  need no re-fetch), plus per-venue lines/volumes when present. Adds 10%
  over-fetch padding; auto-upgrades the timeframe so a window never exceeds
  `MAX_CANDLES` (10K). `TIMEFRAMES` = [6s … 1w]. LRU chunk cache (60 chunks).
- `GET /api/block?time=&scenarios=` — lightweight hover-tooltip lookup: author +
  per-block summary (priceUpdated, inherentTotal, median validator, agreement
  rate, ε coefficient) for the active scenarios. No full vote list.
- Author selection is replayed per-scenario (seeded) for tooltips/detail — never
  written to `.simdata`.

### Per-block detail page

Clicking any block in the chart navigates to `/block?time=<ts>&active=<idxs>`
(`block.html`). It lists **every** scenario in the dataset (collapsed), expands
the ones passed in `active`, and fetches detail lazily per scenario on expand:
- `GET /api/block-detail?scenario=<i>&block=<n>` (or `&time=`) — full detail for
  one scenario at one block: author, prev→new oracle price, real price, median
  validator, agreement rate / ε coefficient, and the **complete inherent vote
  list** (type + value/bump per input). The vote list exists **only** in the
  per-scenario CSV, so this endpoint streams that `<dir>.csv` to the target row
  (block N = line N+1); everything else comes from the chunk + `index.json`.
  The page groups votes by validator type (count + min/median/max, or up/down
  split for nudge), expandable to raw per-input rows. **The CSV is written only
  when the sim ran with `--csv`** — without it the endpoint degrades gracefully
  (no vote list; author/prices still resolve from the chunk).

## Gotchas

- Year-long simulations produce ~5.2M blocks — the run itself takes minutes.
  For quick iteration use ~30 validators and a few days of data.
- `--scenario` is required to simulate; there is no default single-sim path.
- The engine throws on an incompatible (validator type, aggregator) pair — check
  the class's `static compatibleEngines`.
- Velocity-enabled scenarios silently force single-threaded (functions don't
  survive worker `postMessage`).
- `AGENTS.md` overlaps with this file but is partly stale (mentions `mix.ts` /
  "no tests"); prefer this file.

## Upcoming / In-Flight

The **latched-median** aggregator (`PROMPT_LATCHED.md`) is now implemented
(`LatchedMedianAggregator` in `aggregator.ts`, `latched-median` scenario). Only
`honest` and `pushy-max` are wired for it; extending the other adversary types to
behave meaningfully under the latched set is the next step (the prompt reserved
that work). `pushy-max`'s latched-median behavior (extreme-outlier input +
cabal-only, honest-withholding authorship) is an opinionated first cut intended
to be tuned.

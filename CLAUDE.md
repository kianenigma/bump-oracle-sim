# Oracle Bump Simulation

## Project Overview

Simulates an oracle price-bump mechanism where validators submit bumps to track a real price (DOT/USDT). Fetches historical candle data from Binance, interpolates to 6-second blocks, runs the simulation, and visualizes results.

**Runtime**: Bun (no Node.js). Use `bun run src/main.ts` to run.

## Architecture

```
src/
  main.ts              CLI entry point (parseArgs)
  types.ts             All type definitions
  config.ts            Default config, constants (BLOCK_TIME_SECONDS=6)
  rng.ts               Seeded PRNG (mulberry32) + Gaussian RNG
  data/
    fetcher.ts         Binance API client (DOT/USDT candles, with retry)
    cache.ts           Disk cache for fetched data (data/ directory)
    interpolator.ts    Linear interpolation from 1m candles to 6s blocks
  sim/
    engine.ts          Orchestrator: creates validators, runs sim, computes summary
    chain.ts           Block-by-block chain simulation
    validator.ts       HonestValidator + ValidatorAgent interface
    malicious.ts       MaliciousValidator (inverse) + PushyMaliciousValidator (max-push)
    price-endpoint.ts  Wraps price data with per-validator jitter
  analysis/
    scenarios.ts       Named scenario runners (honest, sweep-malicious, sweep-malicious-and-epsilon, sweep-pushy-and-epsilon, epsilon-sweep, stress)
  viz/
    server.ts          Bun.serve() with /api/meta, /api/data endpoints
    aggregation.ts     Server-side OHLC/line/deviation aggregation with binary search
    writer.ts          Writes SimulationResult[] to columnar .simdata JSON
    chart.ts           generateStaticHtml() for --export-html (self-contained HTML)
    template.html      Dual-mode viewer (embedded data OR server fetch)
```

## CLI Modes

```bash
bun run src/main.ts                          # Default: simulate -> .simdata -> server -> browser
bun run src/main.ts --data output.simdata    # Serve existing .simdata without re-running sim
bun run src/main.ts --export-html out.html   # Self-contained HTML (old behavior, with downsampling)
bun run src/main.ts --no-open --port 8080    # Custom port, don't auto-open browser
```

## Key Flags

- `--scenario <name>`: Run a named scenario (honest, sweep-malicious, sweep-malicious-and-epsilon, sweep-pushy-and-epsilon, epsilon-sweep, stress)
- `--start-date` / `--end-date`: Date range (YYYY-MM-DD)
- `--downsampling <none|auto>`: Only applies to --export-html

## Template.html Dual-Mode Design

The template detects its mode via:
```javascript
const EMBEDDED_DATA = /*DATA_PLACEHOLDER*/null;
const IS_SERVER_MODE = EMBEDDED_DATA === null;
```

- **Server mode**: `null` placeholder stays null -> fetches /api/meta + /api/data
- **Embedded mode**: chart.ts replaces placeholder with JSON data

### Chart View Preservation (Critical Pattern)

When switching timeframes or view modes (candle/line), the visible time range MUST be preserved. The pattern:

1. Capture time range BEFORE any series changes: `const saved = getVisibleTimeRange()`
2. Rebuild series with new data
3. Restore with `setVisibleRangeBoth(saved)` which uses a `transitionLock` flag

The `transitionLock` is essential because:
- Lightweight Charts has two synced charts (price + deviation) connected via logical-range sync handlers
- When you programmatically `setVisibleRange()` on one chart, the sync handler fires and converts to logical indices
- After a TF change, logical indices map to different times, so the sync corrupts the view
- `transitionLock` suppresses sync handlers during programmatic range restoration

### Server API

- `GET /api/data` returns BOTH ohlc and line data, so view toggles (candle/line) don't need re-fetches — use cached `lastServerData`
- Server adds 10% over-fetch padding so small pans don't trigger re-fetches
- Auto-upgrades TF if requested window would produce >10K candles
- TF button disabling is based on **visible** window span, not full dataset span

## Type Checking

```bash
npx tsc --noEmit
```

No runtime dependencies — only `@types/bun` and `typescript` as devDependencies.

## .simdata Format

Columnar JSON for efficiency (~60% smaller than array-of-objects):
```json
{
  "version": 1,
  "scenarios": [{
    "config": { ... },
    "summary": { ... },
    "timestamps": [ts1, ts2, ...],
    "realPrices": [p1, p2, ...],
    "oraclePrices": [p1, p2, ...],
    "deviationPcts": [d1, d2, ...]
  }]
}
```

## Simulation Mechanics

- **ValidatorMix**: `Record<string, number>` maps validator type name to fraction (honest is implicit remainder)
- **Validator registry** in engine.ts: `{ malicious: MaliciousValidator, pushy: PushyMaliciousValidator }`
- **Block author selection**: Picked uniformly from **all** validators. Malicious validators can influence both via bumps and via authorship (their `producePrice()` implements their strategy).
- **Auto epsilon**: `maxBlockDelta / validatorCount` — ensures the oracle can track the steepest 6s price move with all validators aligned

## Gotchas

- Year-long simulations produce ~5.2M blocks — the simulation step itself takes a while (minutes)
- Lightweight Charts v4.1.3 is loaded from CDN in the template — `getVisibleRange()` returns `{from, to}` as unix timestamps
- The aggregation binary search uses `lowerBound` (>=) and `upperBound` (>) for half-open `[from, to)` intervals
- `generateStaticHtml()` replaces `/*DATA_PLACEHOLDER*/null` (not `[]`) — if you see the old `[]` placeholder, the embedded mode detection breaks

# Oracle Bump Simulation

Simulates an oracle price-bump mechanism where validators submit bumps to track a real price (DOT/USDT). Fetches historical candle data from Binance, interpolates to 6-second blocks, runs the simulation, and visualizes results in an interactive chart.

## Prerequisites

- [Bun](https://bun.sh/) runtime

```bash
bun install
```

## Quick Start

```bash
# Run with defaults (1 week, opens browser with interactive chart)
bun run src/main.ts

# Custom date range
bun run src/main.ts --start-date 2024-01-01 --end-date 2024-06-30

# Run a named scenario (multi-simulation sweep)
bun run src/main.ts --scenario sweep-malicious-and-epsilon --start-date 2024-01-01 --end-date 2024-03-01
```

## Pre-fetch All Data

Downloads the entire DOT/USDT 1m candle history available on Binance into a local cache. Subsequent simulation runs use this cache and skip network requests.

```bash
bun run src/fetch-all.ts
```

Re-running this script is incremental — it only fetches candles newer than what's already cached.

## CLI Reference

```
bun run src/main.ts [options]

Options:
  --start-date <YYYY-MM-DD>    Start date (default: 2025-01-01)
  --end-date <YYYY-MM-DD>      End date (default: 2025-01-07)
  --epsilon <number|auto>       Price epsilon per bump
  --validators <number>         Number of validators (default: 100)
  --malicious <fraction>        Fraction of malicious validators 0-1 (default: 0)
  --seed <number>               Random seed (default: 42)
  --jitter <fraction>           Price jitter std dev as fraction (default: 0.001)
  --scenario <name>             Run a named scenario
  --output <path>               Output file (default: output.simdata)
  --data <path>                 Serve an existing .simdata file without re-running sim
  --export-html <path>          Export self-contained HTML file
  --fetch-only                  Only fetch and cache price data, don't simulate
  --port <number>               Server port (default: 3000)
  --no-open                     Don't auto-open browser
  --list-scenarios              List available scenario names
  --help                        Show help
```

## Scenarios

| Name | Description |
|------|-------------|
| `honest` | Baseline with 0% malicious validators |
| `sweep-malicious` | Sweeps malicious fraction (0%, 10%, 30%, 49%) |
| `sweep-malicious-and-epsilon` | Sweeps malicious fraction x epsilon combinations |
| `epsilon-sweep` | Sweeps epsilon values with 0% malicious |
| `stress` | 49% malicious stress test |

## Visualization

The default mode starts a local server and opens an interactive chart in the browser with:

- Candlestick/line toggle for price and oracle series
- Timeframe selection (6s to 1w)
- On-demand data loading (zoom in for finer resolution)
- Per-series visibility toggles
- Collapsible stats panel
- Drag-to-zoom, keyboard shortcuts (arrows to pan, +/- to zoom, R to reset)

## Type Checking

```bash
npx tsc --noEmit
```

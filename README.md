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
bun run src/main.ts --scenario sweep-malicious --start-date 2024-01-01 --end-date 2024-03-01

# Run the research grid search (see below)
bun run src/main.ts --scenario research --start-date 2021-12-03 --end-date 2021-12-13 --no-open
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
  --validators <number>         Number of validators (default: 300)
  --mix <spec>                  Validator mix, e.g. "malicious=0.2,pushy=0.1"
  --seed <number>               Random seed (default: 42)
  --jitter <fraction>           Price jitter std dev as fraction (default: 0.001)
  --convergence-threshold <%>   Convergence threshold in % (default: 0.5)
  --scenario <name>             Run a named scenario
  --output <path>               Output directory (default: output.simdata)
  --data <path>                 Serve an existing .simdata directory without re-running sim
  --label <substring>           Filter scenarios by label (case-insensitive substring, use with --data)
  --index <N>                   Filter to a single scenario by index (use with --data)
  --reanalyze                   Re-run scoring/report on existing --data without re-simulating
  --fetch-only                  Only fetch and cache price data, don't simulate
  --threads <number>            Worker threads for batch scenarios (default: CPU count)
  --port <number>               Server port (default: 3000)
  --no-open                     Don't auto-open browser
  --force                       Overwrite existing output directory
  --list-scenarios              List available scenario names
  --help                        Show help
```

## Scenarios

| Name | Description |
|------|-------------|
| `honest` | Baseline with 100% honest validators |
| `sweep-malicious` | Sweeps malicious fraction (0% to 50%) |
| `sweep-malicious-and-epsilon` | Sweeps malicious fraction x epsilon combinations |
| `sweep-pushy-and-epsilon` | Sweeps pushy fraction x epsilon combinations |
| `epsilon-sweep` | Sweeps epsilon multipliers with 100% honest validators |
| `stress` | 49% malicious stress test |
| `research` | Grid search over epsilon x adversary mixes with scoring (see below) |

## Adversary Types

| Type | Bump behavior | Author behavior |
|------|---------------|-----------------|
| `malicious` | Opposite of honest (inverts direction) | Pushes price away from truth |
| `pushy` | Honest (correct direction) | Activates all bumps in correct direction (overshoots) |
| `noop` | Honest | Activates nothing (freezes oracle price) |
| `delayed` | Honest but reads price from 10 blocks ago | Same as honest but uses stale price |
| `drift` | Always bumps Up | Activates all Up bumps (persistent upward drift) |

## Research Scenario

The `research` scenario performs a systematic grid search to find the optimal epsilon value for the oracle mechanism. It evaluates how well different epsilon values perform under both honest and adversarial conditions.

### How it works

1. **Compute auto-epsilon**: `maxBlockDelta(pricePoints) / validatorCount` — the epsilon at which the oracle can exactly track the steepest 6-second price move when all validators agree.

2. **Build the grid**: 10 epsilon multipliers x 16 adversary mixes = 160 simulations.
   - **Epsilon multipliers**: `[0.1x, 0.25x, 0.5x, 0.75x, 1.0x, 1.5x, 2.0x, 3.0x, 4.0x, 5.0x]` of auto-epsilon
   - **Adversary mixes**: baseline (0%), then 10%/20%/33% of each adversary type (malicious, pushy, noop, delayed, drift)

3. **Run all simulations** in parallel using Bun Workers (one per CPU core by default).

4. **Score each simulation** and rank epsilon values.

5. **Generate a report** printed to stdout and saved as `research_report.json`.

### Scoring

Each simulation is scored on a 0–1 scale using a weighted combination of four metrics. All metrics are normalized to [0, 1] where 1 = best.

| Metric | What it measures | Default weight |
|--------|-----------------|----------------|
| **Max deviation** | Worst-case peak divergence from truth | 0.8 |
| **Convergence rate** | % of blocks where deviation < 0.1% | 0.3 |
| **Deviation integral** | Cumulative deviation over time (area under curve) | 0.3 |
| **Mean deviation** | Average deviation across all blocks | 0.1 |

**Hard reject**: If the max deviation ever exceeds `maxAcceptableDeviation` (default: 10%), the simulation scores 0 regardless of other metrics.

The per-simulation score formula:

```
score = (w_maxDev * maxDevScore + w_conv * convergence + w_integral * integral + w_meanDev * meanDev)
        / (w_maxDev + w_conv + w_integral + w_meanDev)
```

### Epsilon ranking

Each epsilon value is ranked by a **composite score** that balances baseline performance with resilience under adversarial conditions:

1. **Baseline score**: The score of the 0% adversary (honest-only) run for that epsilon.
2. **Worst-case score at 33%**: The lowest score among all 33%-adversary runs for that epsilon (across all adversary types).
3. **Resilience gap**: `baselineScore - worstScore33` — how much performance degrades under attack.
4. **Composite score**: `(1 - w_resilience) * baselineScore + w_resilience * (1 - resilienceGap)`

The default resilience weight is 0.5, meaning baseline performance and attack resilience contribute equally to the final ranking.

### Customizing criteria

All weights and thresholds can be overridden via environment variables:

```bash
WEIGHT_MAX_DEVIATION=0.8 WEIGHT_CONVERGENCE=0.3 WEIGHT_INTEGRAL=0.3 \
WEIGHT_MEAN_DEVIATION=0.1 WEIGHT_RESILIENCE=0.5 \
MAX_ACCEPTABLE_DEVIATION=10 CONVERGENCE_THRESHOLD=0.1 \
bun run src/main.ts --scenario research --start-date 2021-12-03 --end-date 2021-12-13 --no-open
```

### Example invocation

```bash
# Run the full research grid (160 sims, parallelized across all CPU cores)
bun run src/main.ts --scenario research --start-date 2021-12-03 --end-date 2021-12-13 --no-open

# Use fewer threads
bun run src/main.ts --scenario research --start-date 2021-12-03 --end-date 2021-12-13 --no-open --threads 4

# Serve all results for visual inspection afterward
bun run src/main.ts --data research_2021-12-03_2021-12-13.simdata

# Serve a single scenario by index
bun run src/main.ts --data research_2021-12-03_2021-12-13.simdata --index 42

# Serve all scenarios matching a label (case-insensitive substring)
bun run src/main.ts --data research_2021-12-03_2021-12-13.simdata --label "1.0x"
bun run src/main.ts --data research_2021-12-03_2021-12-13.simdata --label baseline
```

### Re-analyzing with different weights

After running the research scenario once, you can re-run the scoring and report generation instantly (no re-simulation) with different criteria weights via environment variables:

```bash
# Re-analyze with higher resilience weight
WEIGHT_RESILIENCE=0.8 bun run src/main.ts --data research_2021-12-03_2021-12-13.simdata --reanalyze

# Re-analyze with stricter max deviation threshold
MAX_ACCEPTABLE_DEVIATION=5 bun run src/main.ts --data research_2021-12-03_2021-12-13.simdata --reanalyze
```

This reads all configs and summaries from the existing `index.json`, applies the current criteria, and overwrites `research_report.json` with the new results.

### Report output

The report prints a ranking table and detail table to stdout, and saves a JSON file (`research_report.json`) inside the output directory:

```
EPSILON RANKING (by composite score):
  #1  eps=0.000120 (1.2x)  score=0.847  baseline=0.91  worst@33%=0.78  gap=0.13
  #2  eps=0.000100 (1.0x)  score=0.831  baseline=0.90  worst@33%=0.72  gap=0.18
  ...

CONCLUSION: Optimal epsilon = 0.000120 (1.2x auto-epsilon)
```

## Multi-threading

Batch scenarios (any scenario with multiple simulations) automatically parallelize across Bun Workers. Each worker runs simulations independently and writes its own output files.

- Default thread count: number of CPU cores (`os.cpus().length`)
- Override with `--threads <N>`
- Single simulations always run on the main thread
- Progress is displayed as a live multi-line ANSI display showing per-worker and overall status

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

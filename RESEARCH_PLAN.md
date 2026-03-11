# Research Plan

## Completed

- [x] Fix authorship: `chain.ts` picks authors from ALL validators proportionally
- [x] Memory optimization: chunked directory format, incremental summary, streaming writes
- [x] Removed HTML export (chart.ts deleted, template.html server-only)
- [x] Removed old monolithic .simdata format

## Next: Research Framework

### Overview

Create a `research` scenario that runs a grid search over epsilon values and adversary mixes,
scores each combination, and produces a report recommending the optimal epsilon.

### Files to Create

#### 1. `src/analysis/research-criteria.ts`

Defines the scoring function and criteria config.

```typescript
export interface ResearchCriteria {
  // Weights (0-1). Higher = more important in the composite score.
  weightConvergence: number;     // reward high convergence rate
  weightMeanDeviation: number;   // penalize high mean deviation %
  weightMaxDeviation: number;    // penalize high max deviation %
  weightIntegral: number;        // penalize high deviation integral
  weightResilience: number;      // reward small gap between baseline and 33% malicious

  // Hard thresholds
  maxAcceptableDeviation: number;  // reject epsilon if maxDev% exceeds this (e.g. 5.0)
  convergenceThreshold: number;    // what % counts as "converged" (passed to SimulationConfig)
}

export const DEFAULT_CRITERIA: ResearchCriteria = {
  weightConvergence: 0.3,
  weightMeanDeviation: 0.25,
  weightMaxDeviation: 0.2,
  weightIntegral: 0.15,
  weightResilience: 0.1,
  maxAcceptableDeviation: 5.0,
  convergenceThreshold: 0.5,
};
```

**`loadCriteria()` function**: reads defaults, then overrides from `.env` file if present.
Env var names: `WEIGHT_CONVERGENCE`, `WEIGHT_MEAN_DEVIATION`, `WEIGHT_MAX_DEVIATION`,
`WEIGHT_INTEGRAL`, `WEIGHT_RESILIENCE`, `MAX_ACCEPTABLE_DEVIATION`, `CONVERGENCE_THRESHOLD`.

**`scoreSimulation(summary: SimulationSummary, criteria: ResearchCriteria): number`**:
- Normalize each metric to [0, 1]:
  - convergence: already 0-1 (convergenceRate)
  - meanDeviationPct: `1 - clamp(meanDev / maxAcceptableDev, 0, 1)`
  - maxDeviationPct: `1 - clamp(maxDev / maxAcceptableDev, 0, 1)`
  - integral: `1 - clamp(integral / (totalBlocks * BLOCK_TIME * maxAcceptableDev), 0, 1)`
- Weighted sum of normalized metrics
- Return 0 if maxDeviationPct > maxAcceptableDeviation (hard reject)

**`scoreEpsilon(results: SimulationResult[], criteria): EpsilonScore`**:
- Groups results by epsilon value
- For each epsilon:
  - `baselineScore`: score of the 0% malicious run
  - `worstScore33`: worst score among all 33% malicious runs (across malicious types)
  - `resilienceGap`: baselineScore - worstScore33
  - `compositeScore`: `(1 - weightResilience) * baselineScore + weightResilience * (1 - resilienceGap)`
- Returns ranked list

#### 2. `src/analysis/research-report.ts`

**`generateReport(results, criteria, outputPath?): void`**:
- Computes scores for all results
- Prints formatted table to stdout
- Saves JSON report to `outputPath` (default: `research_report.json`)

Report structure:
```
RESEARCH REPORT
===============
Date range: 2021-12-03 to 2021-12-13 | 144,000 blocks/sim | 70 simulations
Auto-epsilon base: 0.000XXX

EPSILON RANKING (by composite score):
  #1  eps=0.000120 (1.2x)  score=0.847  baseline=0.91  worst@33%=0.78  gap=0.13
  #2  eps=0.000100 (1.0x)  score=0.831  baseline=0.90  worst@33%=0.72  gap=0.18
  ...

DETAIL TABLE:
  epsilon      mix               convRate  meanDev%  maxDev%  integral  score
  0.000120     0% malicious      98.2%     0.12      2.3      142.5     0.91
  0.000120     33% malicious     95.1%     0.25      3.1      198.2     0.78
  0.000120     33% pushy         96.0%     0.18      2.8      170.1     0.82
  ...

CONCLUSION: Optimal epsilon = 0.000120 (1.2x auto-epsilon)
```

Also write `research_report.json`:
```json
{
  "criteria": { ... },
  "autoEpsilon": 0.0001,
  "ranking": [
    { "epsilon": 0.00012, "multiplier": 1.2, "compositeScore": 0.847, ... }
  ],
  "details": [
    { "epsilon": 0.00012, "mix": "0% malicious", "summary": { ... }, "score": 0.91 }
  ],
  "conclusion": { "optimalEpsilon": 0.00012, "multiplier": 1.2 }
}
```

#### 3. Add `research` scenario to `src/analysis/scenarios.ts`

The scenario function:

1. Call `loadCriteria()` to get weights
2. Compute `autoEpsilon = maxBlockDelta(pricePoints) / validatorCount`
3. Define the grid:
   - **Epsilon multipliers**: `[0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0]` (10 values)
   - **Adversary mixes**: `[
       {},                          // 0% (baseline)
       { malicious: 0.1 },
       { malicious: 0.33 },
       { pushy: 0.1 },
       { pushy: 0.33 },
       { noop: 0.1 },
       { noop: 0.33 },
       { delayed: 0.1 },
       { delayed: 0.33 },
       { drift: 0.1 },
       { drift: 0.33 },
     ]` (11 mixes)
   - Total: 110 simulations
4. For each (epsilon, mix) combo, create a SimulationConfig with label like
   `"eps=0.000120 (1.2x), 33% malicious"`
5. Run all via `runBatch()` — pass `outputDir` so block data is saved for manual inspection
6. Call `generateReport(results, criteria, join(outputDir, "research_report.json"))`
7. Return results array

### Key Design Decisions

- **Summary-only for speed**: When `outputDir` is not provided (e.g., research in headless
  mode), `runBatch` calls `runOne` without a ChunkWriter. The engine computes summary
  incrementally without storing block data. For 70 sims × 144K blocks = 10M blocks total,
  this takes ~1 min.

- **With block data for inspection**: When `outputDir` is provided (the default CLI path),
  block data is written to disk in chunks so you can later serve and visually inspect any
  scenario.

- **Timeline**: Use `--start-date 2021-12-03 --end-date 2021-12-13` (10 days, ~144K blocks).
  The overrides come from CLI flags passed to `main.ts`, not hardcoded in the scenario.

### Invocation

```bash
# Run research scenario on 10-day dev period
bun run src/main.ts --scenario research --start-date 2021-12-03 --end-date 2021-12-13 --no-open

# Serve results for visual inspection
bun run src/main.ts --data research_2021-12-03_2021-12-13.simdata
```

### Implementation Checklist

1. Create `src/analysis/research-criteria.ts` with:
   - `ResearchCriteria` interface + `DEFAULT_CRITERIA`
   - `loadCriteria()` (reads `.env` overrides)
   - `scoreSimulation()` (single sim -> normalized score)
   - `scoreEpsilon()` (group by epsilon, compute composite)

2. Create `src/analysis/research-report.ts` with:
   - `generateReport()` (stdout table + JSON file)

3. Add `research` entry to `scenarios` record in `src/analysis/scenarios.ts`

4. Type-check: `npx tsc --noEmit`

5. Test: `bun run src/main.ts --scenario research --start-date 2021-12-03 --end-date 2021-12-13 --no-open`

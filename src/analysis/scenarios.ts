import { join } from "path";
import { mkdirSync } from "fs";
import { epsilonValue } from "../types.js";
import type {
  AggregatorConfig,
  RealPriceSpec,
  EpsilonSpec,
  ResolvedPriceSource,
  ScenarioMeta,
  SimulationConfig,
  SimulationResult,
  ValidatorParams,
  ValidatorPriceSource,
  ValidatorType,
} from "../types.js";
import { DEFAULT_CONFIG, DEFAULT_PRICE_SOURCE, DEFAULT_VALIDATOR_COUNT } from "../config.js";
import { runSimulation, type BlockSink } from "../sim/engine.js";
import { maxBlockDelta } from "../data/interpolator.js";
import { ChunkWriter, CsvWriter, combineSinks, writeIndex, scenarioDirName } from "../viz/writer.js";
import { loadCriteria } from "./research-criteria.js";
import { generateReport } from "./research-report.js";
import { buildValidators, formatValidators, type GroupSpec } from "../validators.js";

// ─────────────────────────────────────────────────────────────────────────────
// Glossary — what each agent does. Full implementations: src/sim/validator.ts,
// src/sim/malicious.ts.
//
// Agents (validator types in any group):
//   honest    Submits an honestly-jittered observation of the real price.
//             Nudge: bump = sign(observed − lastPrice); as author, picks the
//             optimal number of in-direction bumps.
//             Quote: submits the jittered observation directly.
//
//   malicious Inverse strategy. Pushes price *away* from real.
//             Nudge: bump direction flipped; as author activates
//             same-direction bumps (away-from-real).
//             Quote: own input is an outlier opposite real motion of size
//             `params.maliciousQuoteBias × lastPrice`; as author SELECTIVELY
//             includes only gossiped quotes whose value supports the wrong
//             direction (i.e. on the opposite side of lastPrice from real).
//             This is the spec's "select prices that support your value"
//             attack — visible in the block-metric gap between totalBumps
//             (gossiped) and activatedBumps (passed by author).
//
//   pushy     Nudge: honest direction; as author activates ALL in-direction
//             bumps (over-shoot via maximal push).
//             Quote: own input is `real·(1 ± pushyQuoteBias)`, an outlier
//             past real in the direction of motion. As author, SELECTIVELY
//             keeps only quotes whose value is beyond `observed` (≈ real)
//             in the direction of motion — the overshoot variant of
//             malicious's selective-inclusion attack. Threshold is real
//             (not lastPrice) because pushy's goal is "go past real",
//             not "go in the right direction at all".
//
//   noop      Author-side censorship.
//             Nudge: emits honest bumps, as author selects none → freeze.
//             Quote: abstains; as author drops the inherent → freeze.
//
//   delayed  Honest intent, but reads its observation from `delayBlocks` ago.
//
//   drift    Persistent upward bias.
//            Nudge: always Up; as author activates all Up bumps.
//            Quote: lastPrice·(1 + driftQuoteStep) every block.
//
// Aggregators:
//   nudge        Validators submit Up/Down. Author picks subset.
//                price' = lastPrice + (net activated bumps) × ε.
//   median       Validators submit absolute prices. price' = median(quotes).
//   median(k)    Sort, drop top k% and bottom k% by value, then median.
//                k=0 (default) is the plain median.
//   mean(k)      Sort, drop top k% and bottom k% by value, then arithmetic
//                mean. k=0 is a plain mean.
//
// Per-group ValidatorParams (delayBlocks / pushyQuoteBias / driftQuoteStep)
// fall back to DEFAULT_VALIDATOR_PARAMS in src/config.ts. Each scenario can
// override per-group via the `params` field of GroupSpec.
// ─────────────────────────────────────────────────────────────────────────────

// Comparison adversary params used by `aggregator-comparison`. Stronger than
// the defaults so the cross-aggregator differences are visible.
const COMPARISON_PARAMS: Required<ValidatorParams> = {
  delayBlocks: 100,
  pushyQuoteBias: 0.5,
  maliciousQuoteBias: 0.5,
  driftQuoteStep: 0.1,
};

// ── Scenario context ────────────────────────────────────────────────────────
//
// Replaces the old `Partial<SimulationConfig>` overrides bag. The CLI builds
// one of these from --start-date / --validators / --jitter / --aggregator /
// etc., then hands it to a ScenarioFn.
//
// The ctx owns the *defaults* a scenario applies when it doesn't have a
// stronger opinion: validatorCount, the price-source kind/jitter, the
// aggregator (when the scenario doesn't sweep aggregators), and a default
// epsilon (when the aggregator is nudge and the scenario doesn't sweep ε).
export interface ScenarioCtx {
  startDate: string;
  endDate: string;
  seed: number;
  convergenceThreshold: number;
  realPrice: RealPriceSpec;
  /** Default aggregator (the scenario may override per-config). */
  aggregator: AggregatorConfig;
  /** Default per-group price source (the scenario may override per-group). */
  priceSource: ValidatorPriceSource;
  /** Total number of validators in each scenario sim. */
  validatorCount: number;
  /** Default epsilon to use when a scenario doesn't sweep ε itself. */
  defaultEpsilon: EpsilonSpec;
}

export type ScenarioFn = (
  ctx: ScenarioCtx,
  priceSource: ResolvedPriceSource,
  outputDir?: string,
  threadCount?: number,
) => Promise<SimulationResult[]>;

// ── Helpers used by every scenario ──────────────────────────────────────────

/** Build a SimulationConfig from a context + group specs + label + optional aggregator override. */
function makeConfig(
  ctx: ScenarioCtx,
  specs: GroupSpec[],
  label: string,
  aggregatorOverride?: AggregatorConfig,
): SimulationConfig {
  const validators = buildValidators(ctx.validatorCount, specs, ctx.priceSource);
  return {
    startDate: ctx.startDate,
    endDate: ctx.endDate,
    seed: ctx.seed,
    convergenceThreshold: ctx.convergenceThreshold,
    realPrice: ctx.realPrice,
    aggregator: aggregatorOverride ?? ctx.aggregator,
    label,
    validators,
  };
}

/** Convenience: nudge aggregator with the given epsilon (or ctx.defaultEpsilon). */
function nudgeAgg(ctx: ScenarioCtx, epsilon?: EpsilonSpec): AggregatorConfig {
  return { kind: "nudge", epsilon: epsilon ?? ctx.defaultEpsilon };
}

function aggregatorLabel(cfg: AggregatorConfig): string {
  const parts: string[] = [];
  if ((cfg.kind === "median" || cfg.kind === "mean") && cfg.k && cfg.k > 0) parts.push(`k=${cfg.k}`);
  if (cfg.minInputs !== undefined) parts.push(`min=${cfg.minInputs}`);
  return parts.length > 0 ? `${cfg.kind}(${parts.join(",")})` : cfg.kind;
}

/** Convert the legacy "ValidatorMix"-style record into GroupSpec[]. */
function specsFromMix(mix: Record<string, number>): GroupSpec[] {
  const out: GroupSpec[] = [];
  for (const [name, frac] of Object.entries(mix)) {
    if (name === "honest") continue;
    if (frac <= 0) continue;
    out.push({ type: name as Exclude<ValidatorType, "honest">, fraction: frac });
  }
  return out;
}

/**
 * Run a single simulation, optionally writing block data to a scenario subdirectory.
 */
function runOne(
  config: SimulationConfig,
  priceSource: ResolvedPriceSource,
  outputDir: string | undefined,
  scenarioIndex: number,
): { result: SimulationResult; meta?: ScenarioMeta } {
  let writer: ChunkWriter | undefined;
  let csv: CsvWriter | undefined;
  let sink: BlockSink | undefined;

  const dirName = scenarioDirName(config.label, scenarioIndex);
  if (outputDir) {
    writer = new ChunkWriter(join(outputDir, dirName));
    csv = new CsvWriter(join(outputDir, `${dirName}.csv`));
    sink = combineSinks(writer.sink, csv.sink);
  }

  const result = runSimulation(config, priceSource, sink);

  let meta: ScenarioMeta | undefined;
  if (writer) {
    const info = writer.finish();
    csv?.finish();
    meta = {
      config: result.config,
      summary: result.summary,
      blockCount: info.blockCount,
      chunkCount: info.chunkCount,
      timeRange: info.timeRange,
      chunkTimeRanges: info.chunkTimeRanges,
      dir: dirName,
    };
  }

  return { result, meta };
}

/**
 * Run multiple configs as a scenario batch. Uses a Bun Worker pool when
 * threadCount > 1 and there are multiple configs.
 */
async function runBatch(
  configs: SimulationConfig[],
  priceSource: ResolvedPriceSource,
  outputDir?: string,
  threadCount = 1,
): Promise<SimulationResult[]> {
  if (outputDir) mkdirSync(outputDir, { recursive: true });

  let results: SimulationResult[];
  let metas: (ScenarioMeta | undefined)[];

  if (threadCount > 1 && configs.length > 1) {
    ({ results, metas } = await runBatchParallel(configs, priceSource, threadCount, outputDir));
  } else {
    results = [];
    metas = [];
    for (let i = 0; i < configs.length; i++) {
      const { result, meta } = runOne(configs[i], priceSource, outputDir, i);
      results.push(result);
      metas.push(meta);
    }
  }

  if (outputDir) {
    const validMetas = metas.filter((m): m is ScenarioMeta => m !== undefined);
    if (validMetas.length > 0) writeIndex(outputDir, validMetas, priceSource);
  }

  return results;
}

/**
 * Distribute simulations across Bun Workers using a work-stealing pool.
 */
async function runBatchParallel(
  configs: SimulationConfig[],
  priceSource: ResolvedPriceSource,
  threadCount: number,
  outputDir?: string,
): Promise<{ results: SimulationResult[]; metas: (ScenarioMeta | undefined)[] }> {
  const workerCount = Math.min(threadCount, configs.length);
  console.log(`  Spawning ${workerCount} workers for ${configs.length} simulations...\n`);

  const workerURL = new URL("../sim/worker.ts", import.meta.url);
  const workers: Worker[] = [];

  await Promise.all(
    Array.from({ length: workerCount }, () =>
      new Promise<void>((resolve, reject) => {
        const w = new Worker(workerURL);
        workers.push(w);
        w.onmessage = (e) => { if (e.data.type === "ready") resolve(); };
        w.onerror = (e) => reject(e);
        w.postMessage({ type: "init", priceSource });
      })
    )
  );

  const workerState: { label: string; pct: number }[] = Array.from(
    { length: workerCount },
    () => ({ label: "idle", pct: 0 }),
  );
  const workerIndexMap = new Map<Worker, number>();
  workers.forEach((w, i) => workerIndexMap.set(w, i));

  let linesPrinted = 0;
  let lastRedraw = 0;
  const REDRAW_MS = 150;

  function redraw(force = false) {
    const now = Date.now();
    if (!force && now - lastRedraw < REDRAW_MS) return;
    lastRedraw = now;

    if (linesPrinted > 0) process.stdout.write(`\x1B[${linesPrinted}A`);

    let lines = 0;
    for (let i = 0; i < workerCount; i++) {
      const ws = workerState[i];
      const bar = progressBar(ws.pct, 20);
      process.stdout.write(`\x1B[2K  Worker ${String(i + 1).padStart(2)}: ${bar} ${ws.label}\n`);
      lines++;
    }
    const overallBar = progressBar((completed / configs.length) * 100, 20);
    process.stdout.write(`\x1B[2K  Overall: ${overallBar} ${completed}/${configs.length} simulations\n`);
    lines++;
    linesPrinted = lines;
  }

  const results: SimulationResult[] = new Array(configs.length);
  const metas: (ScenarioMeta | undefined)[] = new Array(configs.length);
  let nextTask = 0;
  let completed = 0;

  redraw(true);

  await new Promise<void>((resolveAll, rejectAll) => {
    function assignNext(worker: Worker) {
      const wi = workerIndexMap.get(worker)!;
      if (nextTask >= configs.length) {
        workerState[wi] = { label: "done", pct: 100 };
        redraw(true);
        return;
      }
      const idx = nextTask++;
      workerState[wi] = { label: truncate(configs[idx].label, 50), pct: 0 };
      redraw(true);
      worker.postMessage({
        type: "run",
        config: configs[idx],
        scenarioIndex: idx,
        outputDir,
      });
    }

    for (const w of workers) {
      w.onerror = (e) => rejectAll(e);
      w.onmessage = (event) => {
        const msg = event.data;
        const wi = workerIndexMap.get(w)!;
        if (msg.type === "progress") {
          workerState[wi].pct = msg.pct;
          redraw();
        } else if (msg.type === "done") {
          results[msg.scenarioIndex] = msg.result;
          metas[msg.scenarioIndex] = msg.meta;
          completed++;
          if (completed === configs.length) {
            redraw(true);
            resolveAll();
          } else {
            assignNext(w);
          }
        }
      };
      assignNext(w);
    }
  });

  console.log();

  for (const w of workers) w.terminate();
  return { results, metas };
}

function progressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]" + ` ${pct.toFixed(0).padStart(3)}%`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

const RESEARCH_MULTIPLIERS = [0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];

/** Mixes used by the research scenarios — kept as a record-of-fractions for
 *  readability (same shape as the old ValidatorMix). */
const RESEARCH_MIXES: Record<string, number>[] = [
  {},
  { malicious: 0.1 },
  { malicious: 0.2 },
  { malicious: 0.33 },
  { pushy: 0.1 },
  { pushy: 0.2 },
  { pushy: 0.33 },
  { noop: 0.1 },
  { noop: 0.2 },
  { noop: 0.33 },
  { delayed: 0.1 },
  { delayed: 0.2 },
  { delayed: 0.33 },
  { drift: 0.1 },
  { drift: 0.2 },
  { drift: 0.33 },
];

// ── Scenarios ───────────────────────────────────────────────────────────────

export const scenarios: Record<string, ScenarioFn> = {
  /** Baseline: 100% honest. */
  async honest(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: honest]`);
    const config = makeConfig(ctx, [], "honest (100%)");
    return runBatch([config], priceSource, outputDir, threadCount);
  },

  /** Sweep malicious fraction from 0% to 50%. */
  async "sweep-malicious"(ctx, priceSource, outputDir, threadCount) {
    const fractions = [0, 0.1, 0.2, 0.3, 0.4, 0.49, 0.5];
    const configs = fractions.map((frac) => {
      const label = `${(frac * 100).toFixed(0)}% malicious`;
      const specs = frac > 0 ? [{ type: "malicious" as const, fraction: frac }] : [];
      return makeConfig(ctx, specs, label);
    });
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /** Sweep all malicious variants at fixed (default) ε. */
  async "sweep-all-malicious"(ctx, priceSource, outputDir, threadCount) {
    const configs: SimulationConfig[] = [];
    for (const mix of RESEARCH_MIXES) {
      const specs = specsFromMix(mix);
      const label = formatValidators(buildValidators(ctx.validatorCount, specs, ctx.priceSource));
      configs.push(makeConfig(ctx, specs, label));
    }
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  async "sweep-malicious-and-epsilon"(ctx, priceSource, outputDir, threadCount) {
    const fractions = [0, 0.1, 0.2, 0.3];
    const base = epsilonValue(ctx.defaultEpsilon);
    const epsilons: EpsilonSpec[] = [base / 5, ctx.defaultEpsilon, base * 5];
    const configs: SimulationConfig[] = [];
    for (const frac of fractions) {
      for (const eps of epsilons) {
        const label = `${(frac * 100).toFixed(0)}% malicious, epsilon=${epsilonValue(eps).toFixed(6)}`;
        const specs = frac > 0 ? [{ type: "malicious" as const, fraction: frac }] : [];
        configs.push(makeConfig(ctx, specs, label, nudgeAgg(ctx, eps)));
      }
    }
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  async "sweep-pushy-and-epsilon"(ctx, priceSource, outputDir, threadCount) {
    const fractions = [0, 0.1, 0.2, 0.3];
    const base = epsilonValue(ctx.defaultEpsilon);
    const epsilons: EpsilonSpec[] = [base / 5, ctx.defaultEpsilon, base * 5];
    const configs: SimulationConfig[] = [];
    for (const frac of fractions) {
      for (const eps of epsilons) {
        const label = `${(frac * 100).toFixed(0)}% pushy, epsilon=${epsilonValue(eps).toFixed(6)}`;
        const specs = frac > 0 ? [{ type: "pushy" as const, fraction: frac }] : [];
        configs.push(makeConfig(ctx, specs, label, nudgeAgg(ctx, eps)));
      }
    }
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /** Vary epsilon to find an optimum (always runs the nudge aggregator). */
  async "epsilon-sweep"(ctx, priceSource, outputDir, threadCount) {
    const multipliers = [0.25, 0.5, 1, 2, 4];
    const maxDelta = maxBlockDelta(priceSource.pricePoints);
    const baseEpsilon = maxDelta / ctx.validatorCount;
    const configs = multipliers.map((mult) => {
      const eps = baseEpsilon * mult;
      const label = `epsilon=${eps.toFixed(6)} (${mult}x)`;
      return makeConfig(ctx, [], label, nudgeAgg(ctx, eps));
    });
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /** Stress test: 49% malicious. */
  async stress(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: stress]`);
    const specs: GroupSpec[] = [{ type: "malicious", fraction: 0.49 }];
    return runBatch([makeConfig(ctx, specs, "stress (49% malicious)")], priceSource, outputDir, threadCount);
  },

  /** Edge case: 49% / 50% across all malicious variants. */
  async "edge-malicious"(ctx, priceSource, outputDir, threadCount) {
    const types: Exclude<ValidatorType, "honest">[] = ["malicious", "pushy", "noop", "delayed", "drift"];
    const configs: SimulationConfig[] = [];
    for (const type of types) {
      for (const frac of [0.49, 0.50]) {
        const specs: GroupSpec[] = [{ type, fraction: frac }];
        const label = `${(frac * 100).toFixed(0)}% ${type}`;
        configs.push(makeConfig(ctx, specs, label));
      }
    }
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  async "research-absolute-eps"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: research-absolute-eps]`);
    const criteria = loadCriteria();
    const autoEpsilon = 1 / ctx.validatorCount / 10;
    console.log(`  Auto-epsilon base: ${autoEpsilon.toFixed(6)}`);

    const epsilonMultipliers = new Map<number, number>();
    for (const mult of RESEARCH_MULTIPLIERS) {
      epsilonMultipliers.set(autoEpsilon * mult, mult);
    }

    const configs: SimulationConfig[] = [];
    for (const mult of RESEARCH_MULTIPLIERS) {
      const eps = autoEpsilon * mult;
      for (const mix of RESEARCH_MIXES) {
        const specs = specsFromMix(mix);
        const mixDesc = formatValidators(buildValidators(ctx.validatorCount, specs, ctx.priceSource));
        const label = `eps=${eps.toFixed(6)} (${mult}x), ${mixDesc}`;
        const cfg: SimulationConfig = {
          ...makeConfig(ctx, specs, label, nudgeAgg(ctx, eps)),
          convergenceThreshold: criteria.convergenceThreshold,
        };
        configs.push(cfg);
      }
    }

    console.log(`  Grid: ${RESEARCH_MULTIPLIERS.length} epsilons x ${RESEARCH_MIXES.length} mixes = ${configs.length} simulations`);
    const results = await runBatch(configs, priceSource, outputDir, threadCount);
    const reportPath = outputDir ? join(outputDir, "research_report.json") : "research_report.json";
    generateReport(results, epsilonMultipliers, criteria, autoEpsilon, reportPath);
    return results;
  },

  async "research-ratio-eps"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: research-ratio-eps]`);
    const criteria = loadCriteria();
    const autoRatio = 0.01 / ctx.validatorCount;
    console.log(`  Auto-ratio base: ${(autoRatio * 100).toFixed(6)}% per bump (1% collective / ${ctx.validatorCount} validators)`);

    const epsilonMultipliers = new Map<number, number>();
    for (const mult of RESEARCH_MULTIPLIERS) {
      epsilonMultipliers.set(autoRatio * mult, mult);
    }

    const configs: SimulationConfig[] = [];
    for (const mult of RESEARCH_MULTIPLIERS) {
      const ratio = autoRatio * mult;
      for (const mix of RESEARCH_MIXES) {
        const specs = specsFromMix(mix);
        const mixDesc = formatValidators(buildValidators(ctx.validatorCount, specs, ctx.priceSource));
        const label = `ratio=${(ratio * 100).toFixed(4)}% (${mult}x), ${mixDesc}`;
        const cfg: SimulationConfig = {
          ...makeConfig(ctx, specs, label, nudgeAgg(ctx, { ratio })),
          convergenceThreshold: criteria.convergenceThreshold,
        };
        configs.push(cfg);
      }
    }

    console.log(`  Grid: ${RESEARCH_MULTIPLIERS.length} ratios x ${RESEARCH_MIXES.length} mixes = ${configs.length} simulations`);
    const results = await runBatch(configs, priceSource, outputDir, threadCount);
    const reportPath = outputDir ? join(outputDir, "research_report.json") : "research_report.json";
    generateReport(results, epsilonMultipliers, criteria, autoRatio, reportPath);
    return results;
  },

  /**
   * Cross-aggregator malicious-fraction sweep. `pushy` and `noop` are
   * primarily author-side attacks under nudge — their quote translations are
   * weaker / structurally different. See TASKS.md §C.
   *
   * Cross-product: 3 aggregators × (1 honest + 2 types × 4 fractions) = 27.
   */
  async "aggregator-comparison"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: aggregator-comparison]`);
    const aggregators: AggregatorConfig[] = [
      nudgeAgg(ctx),
      { kind: "median", minInputs: 0 },
      { kind: "median", minInputs: Math.floor(2 * ctx.validatorCount / 3) + 1 },
    ];
    const adversaryTypes: Exclude<ValidatorType, "honest">[] = ["malicious", "pushy", "noop", "drift"];
    const fractions = [0.10, 0.33, 0.49, 0.5];

    const configs: SimulationConfig[] = [];
    for (const agg of aggregators) {
      // Baseline (honest) per aggregator.
      configs.push(makeConfig(ctx, [], `${aggregatorLabel(agg)} · honest`, agg));

      for (const type of adversaryTypes) {
        for (const frac of fractions) {
          const label = `${aggregatorLabel(agg)} · ${type}@${(frac * 100).toFixed(0)}%`;
          const specs: GroupSpec[] = [{ type, fraction: frac, params: COMPARISON_PARAMS }];
          configs.push(makeConfig(ctx, specs, label, agg));
        }
      }
    }

    console.log(`  Grid: ${aggregators.length} aggregators × (1 honest + ${adversaryTypes.length} types × ${fractions.length} fractions) = ${configs.length}`);
    console.log(`  Comparison knobs: maliciousQuoteBias=${(COMPARISON_PARAMS.maliciousQuoteBias * 100).toFixed(1)}%, pushyQuoteBias=${(COMPARISON_PARAMS.pushyQuoteBias * 100).toFixed(1)}%, delayBlocks=${COMPARISON_PARAMS.delayBlocks}, driftQuoteStep=${(COMPARISON_PARAMS.driftQuoteStep * 100).toFixed(1)}%`);
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /**
   * Compare validator-observation modes under realistic per-trade data.
   * Requires a trades data source with ≥1 venue. Sweeps:
   *   - 2 obs modes (cross-venue, random-venue)
   *   - 3 aggregators (nudge, median, mean(k=0.1))
   *   - 4 malicious fractions (0, 10%, 33%, 49%)
   */
  async "validator-observation"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: validator-observation]`);
    if (!priceSource.venuePrices) {
      throw new Error(
        `validator-observation scenario requires --data-source=trades and ≥1 venue. ` +
        `Re-run with: --data-source trades --venues binance,bybit,gate,kraken`,
      );
    }

    const obsKinds: ("cross-venue" | "random-venue")[] = ["cross-venue", "random-venue"];
    const aggregators: AggregatorConfig[] = [
      nudgeAgg(ctx),
      { kind: "median" },
      { kind: "mean", k: 0.1 },
    ];
    const fractions = [0, 0.10, 0.33, 0.49];

    const configs: SimulationConfig[] = [];
    for (const obs of obsKinds) {
      const ps: ValidatorPriceSource = { kind: obs, jitterStdDev: ctx.priceSource.jitterStdDev };
      const obsCtx: ScenarioCtx = { ...ctx, priceSource: ps };
      for (const agg of aggregators) {
        for (const frac of fractions) {
          const aggLabel = aggregatorLabel(agg);
          const advLabel = frac === 0 ? "honest" : `mal@${(frac * 100).toFixed(0)}%`;
          const specs: GroupSpec[] = frac === 0 ? [] : [{ type: "malicious", fraction: frac }];
          const label = `${obs} obs · ${aggLabel} · ${advLabel}`;
          configs.push(makeConfig(obsCtx, specs, label, agg));
        }
      }
    }

    console.log(`  Grid: ${obsKinds.length} obs modes × ${aggregators.length} aggregators × ${fractions.length} fractions = ${configs.length}`);
    return runBatch(configs, priceSource, outputDir, threadCount);
  },
};

export function listScenarios(): string[] {
  return Object.keys(scenarios);
}

// Re-export for callers (main.ts) that need to spell the default ctx.
export { DEFAULT_CONFIG, DEFAULT_PRICE_SOURCE, DEFAULT_VALIDATOR_COUNT };

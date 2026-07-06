import { join } from "path";
import { mkdirSync } from "fs";
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
  VelocityConfig,
} from "../types.js";
import { DEFAULT_CONFIG, DEFAULT_PRICE_SOURCE, DEFAULT_VALIDATOR_COUNT, BLOCK_TIME_SECONDS } from "../config.js";
import { runSimulation, type BlockSink } from "../sim/engine.js";
import { ChunkWriter, CsvWriter, combineSinks, writeIndex, scenarioDirName } from "../viz/writer.js";
import { loadCriteria } from "./research-criteria.js";
import { generateReport } from "./research-report.js";
import { buildValidators, formatValidators, isCompatibleWithAggregator, type GroupSpec } from "../validators.js";
import { config } from "process";

// ─────────────────────────────────────────────────────────────────────────────
// Glossary — what each agent does. Full implementations: src/sim/validator.ts,
// src/sim/malicious.ts.
//
// Engines:
//   nudge          Validators submit Up/Down. Author picks subset.
//                  price' = lastPrice + (net activated bumps) × ε.
//   median         Validators submit absolute prices. price' = median(inherent quotes).
//   latched-median Like median, but NO minInputs and the per-validator last
//                  quote is latched: price' = median over the full latched set,
//                  refreshed each block by the inherent. Currently exercised by
//                  honest + pushy-max only (see compatibleEngines).
//
// Validators (and the engines they declare compatibility with):
//   honest        — both. Submits a jittered observation; honest nudge author.
//   malicious     — both. Inverse strategy; pushes price AWAY from real.
//   pushy         — both. Honest direction but overshoots past real.
//   pushy-max     — nudge only. Picks whichever bump direction yields the
//                   larger divergence from the author's observation of real.
//   noop          — both. Author-side censorship (drops the inherent).
//   delayed       — both. Honest intent, reads observation `delayBlocks` ago.
//   drift         — both. Persistent upward bias regardless of real price.
//
// Per-group ValidatorParams (delayBlocks / pushyQuoteBias / maliciousQuoteBias
// / driftQuoteStep / withholderDirection) fall back to
// DEFAULT_VALIDATOR_PARAMS in src/config.ts. Each scenario can override
// per-group via the `params` field of GroupSpec.
// ─────────────────────────────────────────────────────────────────────────────

// Comparison adversary params used by `aggregator-comparison`. Stronger than
// the defaults so cross-engine differences are visible.
const COMPARISON_PARAMS: Required<ValidatorParams> = {
  delayBlocks: 100,
  pushyQuoteBias: 0.5,
  maliciousQuoteBias: 0.5,
  driftQuoteStep: 0.1,
  withholderDirection: "up",
};

// ── Scenario context ────────────────────────────────────────────────────────
//
// The CLI builds one of these from --start-date / --validators / --jitter /
// etc., then hands it to a ScenarioFn.
//
// The ctx owns the *defaults* a scenario applies when it doesn't have a
// stronger opinion: validatorCount, the price-source kind/jitter, and the
// aggregator (when the scenario doesn't sweep aggregators). Epsilon is NOT
// in the ctx — every scenario that needs ε computes its own explicitly via
// `ratioEpsilon(validatorCount, multiplier?)`, so there's no implicit
// default that can decouple from the scenario's actual validator count.
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
  /** Write the per-block `<dir>.csv` for each scenario (CLI `--csv`). Off by
   *  default; only the block-detail vote list needs it and it's large. */
  writeCsv: boolean;
}

export type ScenarioFn = (
  ctx: ScenarioCtx,
  priceSource: ResolvedPriceSource,
  outputDir?: string,
  threadCount?: number,
) => Promise<SimulationResult[]>;

// ── Helpers used by every scenario ──────────────────────────────────────────
//
// `formatScenarioLabel` produces the canonical compact label every scenario
// uses. Format: `<engine> | <mix> [suffix]`, where:
//   <engine>   nudge:<ε>      or median[:min=<N>]
//   <ε>        "auto" | "r=<pct>%" (ratio mode) | numeric (scientific when
//              |ε| < 1e-3 for compactness, fixed otherwise)
//   <mix>      "honest" (100% honest) | comma-joined "N% type" list
//   [suffix]   optional free-form tag (e.g. "(2x)" for ε-sweep variants)
// The function is exported so other code paths (CSV writers, summaries,
// future analysis tools) can produce identical labels without duplication.

function formatEpsilon(eps: EpsilonSpec): string {
  if (eps === "auto") return "auto";
  if (typeof eps === "object" && "ratio" in eps) return `r=${(eps.ratio * 100).toFixed(6)}%`;
  const n = eps as number;
  return Math.abs(n) >= 1e-3 ? n.toFixed(6) : n.toExponential(6);
}

function formatEngine(cfg: AggregatorConfig): string {
  if (cfg.kind === "nudge") return `nudge:${formatEpsilon(cfg.epsilon)}`;
  if (cfg.kind === "latched-median") return "latched-median";
  return cfg.minInputs !== undefined ? `median:min=${cfg.minInputs}` : "median";
}

function formatMix(
  specs: GroupSpec[],
  validatorCount: number,
  priceSource: ValidatorPriceSource,
): string {
  return specs.length === 0
    ? "honest"
    : formatValidators(buildValidators(validatorCount, specs, priceSource));
}

/** Single source of truth for scenario labels. Compact, reuseable. */
export function formatScenarioLabel(
  aggregator: AggregatorConfig,
  specs: GroupSpec[],
  validatorCount: number,
  priceSource: ValidatorPriceSource,
  suffix?: string,
): string {
  const base = `${formatEngine(aggregator)} | ${formatMix(specs, validatorCount, priceSource)}`;
  return suffix ? `${base} ${suffix}` : base;
}

/** Build a SimulationConfig with the canonical label. */
function makeConfig(
  ctx: ScenarioCtx,
  specs: GroupSpec[],
  aggregatorOverride?: AggregatorConfig,
  /** Optional extra label suffix (e.g. for sweep variant tagging). */
  labelSuffix?: string,
  /** Optional date-range override; defaults to ctx.{start,end}Date. */
  dateRange?: { startDate: string; endDate: string },
): SimulationConfig {
  const validators = buildValidators(ctx.validatorCount, specs, ctx.priceSource);
  const aggregator = aggregatorOverride ?? ctx.aggregator;
  return {
    startDate: dateRange?.startDate ?? ctx.startDate,
    endDate: dateRange?.endDate ?? ctx.endDate,
    seed: ctx.seed,
    convergenceThreshold: ctx.convergenceThreshold,
    realPrice: ctx.realPrice,
    aggregator,
    label: formatScenarioLabel(aggregator, specs, ctx.validatorCount, ctx.priceSource, labelSuffix),
    validators,
    writeCsv: ctx.writeCsv,
  };
}

/** Convenience: nudge aggregator with the given epsilon. */
function nudgeAgg(epsilon: EpsilonSpec): AggregatorConfig {
  return { kind: "nudge", epsilon };
}

/** Single source of truth for the default ratio epsilon: when ALL N
 *  validators agree on a direction, the oracle moves 1% of price that block
 *  (i.e. per-bump ratio = 0.01 / N). The optional `multiplier` is how
 *  scenarios sweep ε — `ratioEpsilon(N, 0.2)` = "1/5 of the default",
 *  `ratioEpsilon(N, 5)` = "5× the default", etc. — without ever having to
 *  reconstruct the 0.01 constant inline. */
function ratioEpsilon(validatorCount: number, multiplier: number = 1): EpsilonSpec {
  return { ratio: (0.01 / validatorCount) * multiplier };
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
    if (config.writeCsv) csv = new CsvWriter(join(outputDir, `${dirName}.csv`));
    sink = combineSinks(writer.sink, csv?.sink);
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

  // Velocity policies live as functions on the aggregator config; structured-
  // clone (the worker postMessage codec) silently drops them. Force the run
  // single-threaded when any config opts into velocity so the policies actually
  // make it into the simulation.
  const hasVelocity = configs.some(
    (c) => c.aggregator?.kind === "nudge" && c.aggregator.velocity !== undefined,
  );
  if (hasVelocity && threadCount > 1) {
    console.log(`  Velocity-enabled configs detected — forcing single-threaded run.`);
    threadCount = 1;
  }

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

const RESEARCH_MULTIPLIERS = [0.05, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];

/**
 * Scan a completed min-epsilon sweep and report the SMALLEST ε whose longest
 * consecutive run above `targetPct` divergence stays within `maxBlocksBudget`
 * blocks. This is the only criterion needed: a budget of 0 means "never above
 * the target at all" (the strict bound), and larger budgets tolerate brief
 * excursions that recover within that many blocks. The streak comes from the
 * summary's `maxConsecutiveBlocksAboveThreshold`, measured against each config's
 * convergenceThreshold (pinned to targetPct by the scenario).
 *
 * Prints the full ε → (maxDev, longest-streak) curve so the feasible edge is
 * visible. `maxDev%` is shown as context only — the pass/fail is the streak.
 */
function reportMinEpsilon(
  results: SimulationResult[],
  targetPct: number,
  maxBlocksBudget: number,
  blockTimeSeconds: number,
): void {
  const rows = results
    .map((r) => ({
      epsilon: r.summary.epsilon,
      ratioPct: r.summary.epsilonMode === "ratio" ? r.summary.epsilon * 100 : NaN,
      maxDevPct: r.summary.maxDeviationPct,
      maxStreak: r.summary.maxConsecutiveBlocksAboveThreshold,
      label: r.config.label,
    }))
    .sort((a, b) => a.epsilon - b.epsilon);

  const fmtEps = (row: { ratioPct: number; epsilon: number }) =>
    isNaN(row.ratioPct) ? row.epsilon.toExponential(6) : `${row.ratioPct.toFixed(6)}%`;
  const fmtBlocksTime = (blocks: number) => {
    const sec = blocks * blockTimeSeconds;
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${(sec / 60).toFixed(1)}m`;
    return `${(sec / 3600).toFixed(1)}h`;
  };

  const budgetDesc = maxBlocksBudget === 0
    ? `never above ${targetPct}% at all`
    : `never above ${targetPct}% for more than ${maxBlocksBudget} blocks (${fmtBlocksTime(maxBlocksBudget)})`;

  console.log(`\n  ── min-epsilon results (sorted by ε) ──`);
  console.log(`  criterion: ${budgetDesc}`);
  console.log(`  ${"ratio ε".padStart(12)}  ${"maxDev%".padStart(9)}  ${"longest streak".padStart(20)}  ${"meets".padStart(6)}`);
  for (const row of rows) {
    const meets = row.maxStreak <= maxBlocksBudget;
    const streakStr = `${row.maxStreak.toLocaleString()} blk (${fmtBlocksTime(row.maxStreak)})`;
    console.log(
      `  ${fmtEps(row).padStart(12)}  ${row.maxDevPct.toFixed(4).padStart(9)}  ${streakStr.padStart(20)}  ${(meets ? "✓" : "✗").padStart(6)}`,
    );
  }

  const passing = rows.filter((r) => r.maxStreak <= maxBlocksBudget);
  if (passing.length === 0) {
    const best = rows.reduce((a, b) => (a.maxStreak <= b.maxStreak ? a : b));
    console.log(`\n  ✗ No ε in the sweep meets the criterion. Closest: ${fmtEps(best)} (longest streak ${best.maxStreak.toLocaleString()} blk = ${fmtBlocksTime(best.maxStreak)}). Extend the grid upward.`);
    return;
  }

  // `passing` is sorted ascending by ε — the first entry is the smallest.
  const s = passing[0];
  console.log(`\n  ✓ Smallest ε that ${budgetDesc}: ${fmtEps(s)} per bump`);
  console.log(`    longest streak ${s.maxStreak.toLocaleString()} blk = ${fmtBlocksTime(s.maxStreak)}, maxDev ${s.maxDevPct.toFixed(4)}% → ${s.label}`);
  if (s === rows[0]) console.log(`    ⚠ smallest ε tested — true minimum may be lower; extend the grid downward.`);
}

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

/**
 * The intersection of per-venue trade-data availability — i.e. the window
 * within which every one of the 6 venues (binance, bybit, coinbase, gate,
 * kraken, okx) has at least 10% of daily 6s buckets populated with real
 * trades. Re-derive with `bun run scripts/find-data-start.ts` after any
 * fresh backfill. Consumed by `all-venues-honest`.
 *
 * Last updated: 2026-05-24 backfill run. Per-venue real-data ranges:
 *   binance:   2020-08-19 → 2026-05-23
 *   bybit:     2022-11-10 → 2026-05-23  (binds the intersection start)
 *   coinbase:  2021-06-16 → 2026-05-23
 *   gate:      2020-07-16 → 2026-04-30
 *   kraken:    2020-08-18 → 2026-05-22
 *   okx:       2021-09-01 → 2025-10-30  (binds the intersection end)
 *
 * NOTE: dates further back than the venue's listing day were cached as
 * empty 14400-bucket placeholders by the backfill script — those are
 * skipped by the "first-real-data" walker. The cache directory carries
 * them but the simulator would see all-null venue prices on those days.
 */
export const ENTIRE_VENUES_HISTORY = {
  startDate: "2022-11-10",
  endDate: "2025-10-30",
};

// ── Scenarios ───────────────────────────────────────────────────────────────
//
// Every scenario emits configs labelled `[engine=<X>] [mix=<Y>]`. Pick a
// scenario by what it sweeps: validator mix, ε, or the engine itself.
//
// Cross-engine attacker compatibility is enforced by `isCompatibleWithAggregator`
// (which reads each class's static `compatibleEngines`). Configs that would
// mix an incompatible (engine, validator) pair are dropped before they reach
// the runner.

export const scenarios: Record<string, ScenarioFn> = {
  /** 100% honest baseline across both aggregators: nudge at the default
   *  ratio ε (1% per fully-agreed block), nudge at 2× that, and median. */
  async honest(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: honest]`);
    const configs: SimulationConfig[] = [
      makeConfig(ctx, [], nudgeAgg(ratioEpsilon(ctx.validatorCount, 0.5))),
      makeConfig(ctx, [], nudgeAgg(ratioEpsilon(ctx.validatorCount))),
      makeConfig(ctx, [], nudgeAgg(ratioEpsilon(ctx.validatorCount, 2))),
      makeConfig(ctx, [], { kind: "median", minInputs: ctx.validatorCount * 2 / 3 + 1 }),
      makeConfig(ctx, [], { kind: "latched-median" }),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /** 100% honest baseline across both aggregators (nudge + median), running
   *  over the FULL window for which every venue has trade data. Date range
   *  is the intersection of per-venue cached date ranges (see
   *  `ENTIRE_VENUES_HISTORY` below). Pulls trade data from all 6 venues
   *  with the cross-venue mean as the real price. */
  async "entire-venue-history"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: all-venues-honest]`);
    const range = ENTIRE_VENUES_HISTORY;
    console.log(`  Date range (intersection across all venues): ${range.startDate} → ${range.endDate}`);
    const configs: SimulationConfig[] = [
      makeConfig(ctx, [], nudgeAgg(ratioEpsilon(ctx.validatorCount)), undefined, range),
      makeConfig(ctx, [], { kind: "median" }, undefined, range),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  async "nudge-velocity"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: nudge-velocity]`);

    // Non-compounding: each block's ε lands on either `baseEpsilon` (no
    // boost) or `baseEpsilon × maxMultiplier` (gate fired). The
    // `baseEpsilon` arg to nextEpsilonCoefficient is unused here — the
    // coefficient is a constant by-design, and any cap is implicit in
    // that constant value.
    const maxMultiplier = 4;
    const proposeNext = (r: number, _baseEps: number) =>
      r >= 0.51 ? maxMultiplier : 1.0;
    const gateNext = (r: number) => r >= 0.51;
    const bidirectional: VelocityConfig = {
      up: { nextEpsilonCoefficient: proposeNext, agreementGate: gateNext },
      down: { nextEpsilonCoefficient: proposeNext, agreementGate: gateNext },
    };

    // The baseline scenario walks at the default ratio ε every block. The
    // velocity scenario starts from baseEpsilon = default / maxMultiplier
    // so a fully-boosted block (gate fired, coefficient × maxMultiplier)
    // lands on the same effective ε as the baseline. With no boost it walks
    // 1/maxMultiplier as fast — the cost of needing full consensus to match
    // the baseline's step. Head-to-head, both scenarios share the same
    // upper bound on per-block oracle movement.
    const baselineAgg: AggregatorConfig = nudgeAgg(ratioEpsilon(ctx.validatorCount));
    const velocityAgg: AggregatorConfig = {
      kind: "nudge",
      epsilon: ratioEpsilon(ctx.validatorCount, 1 / maxMultiplier),
      velocity: bidirectional,
    };

    // Validator mixes swept against both baseline-nudge and velocity-nudge:
    // 100% honest plus 10/33/49% pushy. Each mix gives a (baseline, velocity)
    // pair so the velocity ε-schedule can be compared head-to-head with the
    // fixed-ε aggregator under the same attacker pressure.
    const mixes: GroupSpec[][] = [
      [],
      [{ type: "pushy-max", fraction: 0.10 }],
      [{ type: "pushy-max", fraction: 0.33 }],
      [{ type: "pushy-max", fraction: 0.49 }],
    ];
    const configs: SimulationConfig[] = [];
    for (const specs of mixes) {
      configs.push(makeConfig(ctx, specs, baselineAgg, "(baseline)"));
      configs.push(makeConfig(ctx, specs, velocityAgg, "(velocity)"));
    }
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /** engine=ctx.aggregator × {0, 10, 20, 30, 40, 49, 50}% malicious. */
  async "sweep-malicious"(ctx, priceSource, outputDir, threadCount) {
    const fractions = [0, 0.1, 0.2, 0.3, 0.4, 0.49, 0.5];
    const configs = fractions.map((frac) => {
      const specs = frac > 0 ? [{ type: "malicious" as const, fraction: frac }] : [];
      return makeConfig(ctx, specs);
    });
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /** engine=ctx.aggregator × every (validator type × fraction) in RESEARCH_MIXES. */
  async "sweep-all-malicious"(ctx, priceSource, outputDir, threadCount) {
    const configs: SimulationConfig[] = [];
    for (const mix of RESEARCH_MIXES) {
      const specs = specsFromMix(mix);
      // Filter incompatible (e.g. withholder under median).
      const allCompatible = specs.every((s) => isCompatibleWithAggregator(s.type, ctx.aggregator.kind));
      if (!allCompatible) continue;
      configs.push(makeConfig(ctx, specs));
    }
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  async "nudge-pushy-max-with-eps"(ctx, priceSource, outputDir, threadCount) {
    // custom epsilon value derived from the research-ratio-eps scenario or a similar scenario
    const epsilon = 0.0075 * 0.01;
    const fractions = [0, 0.05, 0.10, 0.33];
    const configs = [];

    for (const fraction of fractions) {
      const specs: GroupSpec[] = [{ type: "pushy-max", fraction: fraction }];
      configs.push(makeConfig(ctx, specs, { kind: "nudge", epsilon: { ratio: epsilon } }));
    }

    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  // Set of attackers that only want to push the price down.
  async "redemption-attacker"(ctx, priceSource, outputDir, threadCount) {
    const epsilon = 0.0075 * 0.01;
    const configs: SimulationConfig[] = [];
    for (const fraction of [0.05, 0.10, 0.33]) {
      const specs: GroupSpec[] = [{ type: "redemption", fraction: fraction }];
      configs.push(makeConfig(ctx, specs, { kind: "nudge", epsilon: { ratio: epsilon } }));
    }
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /**
   * Find the smallest pure-nudge epsilon that tracks DOT well over its whole
   * history since the start of 2023: the smallest ε whose longest consecutive
   * run above TARGET_PCT divergence stays within MAX_BLOCKS_ABOVE blocks.
   *
   * One criterion covers both questions — MAX_BLOCKS_ABOVE = 0 means "never
   * exceeds the target at all" (the strict bound); a larger budget tolerates
   * brief excursions that recover within that many blocks.
   *
   * All validators are honest and read the SAME combined ground-truth price
   * (cross-venue, jitter=0) — so every block they unanimously agree on the bump
   * direction. The combination rule (mean vs vwap) is whatever the ground-truth
   * data was loaded with (`--cross-venue`), so this scenario honours either.
   *
   * Sweeps a geometric grid of ratio epsilons. Smaller ε tracks slower
   * (divergence lingers above target on fast moves); large ε overshoots — so
   * the answer is the lower edge of the feasible band.
   */
  async "min-epsilon"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: min-epsilon]`);

    // Divergence threshold the oracle is judged against (percent).
    const TARGET_PCT = 0.5;
    // The oracle may briefly exceed TARGET_PCT, but never for more than this many
    // consecutive 6s blocks before recovering back under it. Set to 0 to require
    // it never exceed TARGET_PCT at all.
    const MAX_BLOCKS_ABOVE = 10;
    // Geometric sweep of ratio-ε multipliers (× the default 0.01/N). mult=1 means
    // a fully-agreed block moves the oracle 1% of price; the grid spans ~0.02×
    // (too slow to track) up to ~4× so the feasible band's lower edge is bracketed.
    const MULTIPLIERS: number[] = Array.from({ length: 20 }, (_, i) => 0.02 * Math.pow(1.32, i));

    // Force the observation model regardless of CLI --validator-price-source /
    // --jitter: every validator sees the same combined ground truth with no
    // jitter, so honest agreement is unanimous each block.
    ctx.priceSource = { kind: "cross-venue", jitterStdDev: 0 };

    // Pin convergenceThreshold = TARGET_PCT on every config so the summary's
    // maxConsecutiveBlocksAboveThreshold counts runs above the target.
    const configs = MULTIPLIERS.map((mult) => ({
      ...makeConfig(ctx, [], nudgeAgg(ratioEpsilon(ctx.validatorCount, mult)), `(${mult.toPrecision(3)}x)`),
      convergenceThreshold: TARGET_PCT,
    }));

    const baselineRatio = 0.01 / ctx.validatorCount; // the mult=1 default ε
    console.log(`  Baseline ε (1×): ratio=${(baselineRatio * 100).toFixed(6)}% per bump (0.01 / ${ctx.validatorCount} validators)`);
    console.log(`  Sweeping ${MULTIPLIERS.length} ratio epsilons spanning ${MULTIPLIERS[0].toPrecision(2)}×–${MULTIPLIERS[MULTIPLIERS.length - 1].toPrecision(2)}× baseline (all honest, pure nudge, cross-venue jitter=0)`);
    console.log(`  Criterion: never above ${TARGET_PCT}% divergence for more than ${MAX_BLOCKS_ABOVE} blocks (0 = never at all)`);
    const results = await runBatch(configs, priceSource, outputDir, threadCount);

    reportMinEpsilon(results, TARGET_PCT, MAX_BLOCKS_ABOVE, BLOCK_TIME_SECONDS);
    return results;
  },

  /** engine=ctx.aggregator × {49, 50}% × {malicious, pushy, noop, delayed, drift}. */
  async "edge-malicious"(ctx, priceSource, outputDir, threadCount) {
    const types: Exclude<ValidatorType, "honest">[] = ["malicious", "pushy", "noop", "delayed", "drift"];
    const configs: SimulationConfig[] = [];
    for (const type of types) {
      for (const frac of [0.49, 0.50]) {
        const specs: GroupSpec[] = [{ type, fraction: frac }];
        if (!isCompatibleWithAggregator(type, ctx.aggregator.kind)) continue;
        configs.push(makeConfig(ctx, specs));
      }
    }
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /** engine=nudge(ε ∈ RESEARCH_MULTIPLIERS × auto-ε) × every RESEARCH_MIXES entry. */
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
        const cfg: SimulationConfig = {
          ...makeConfig(ctx, specs, nudgeAgg(eps), `(${mult}x)`),
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

  /** engine=nudge(ratio ∈ RESEARCH_MULTIPLIERS × auto-ratio) × every RESEARCH_MIXES entry. */
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
        const cfg: SimulationConfig = {
          ...makeConfig(ctx, specs, nudgeAgg({ ratio }), `(${mult}x)`),
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

  /** engine={latched-median, median(min=floor(2N/3))} × {0, 10, 33, 49}% pushy-max.
   *  Head-to-head of the latched aggregator vs plain median under the only two
   *  validator types wired for it so far (honest + pushy-max). */
  async "latched-median"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: latched-median]`);
    const aggregators: AggregatorConfig[] = [
      { kind: "latched-median" },
      { kind: "median", minInputs: Math.floor(2 * ctx.validatorCount / 3) },
    ];
    const fractions = [0, 0.10, 0.33, 0.49];
    const configs: SimulationConfig[] = [];
    for (const agg of aggregators) {
      for (const frac of fractions) {
        const specs: GroupSpec[] = frac > 0 ? [{ type: "pushy-max", fraction: frac }] : [];
        configs.push(makeConfig(ctx, specs, agg));
      }
    }
    console.log(`  Grid: ${aggregators.length} engines × ${fractions.length} pushy-max fractions = ${configs.length} configs`);
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  async "aggregator-comparison"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: aggregator-comparison]`);
    const aggregators: AggregatorConfig[] = [
      nudgeAgg(ratioEpsilon(ctx.validatorCount, 0.5)),
      nudgeAgg(ratioEpsilon(ctx.validatorCount)),
      nudgeAgg(ratioEpsilon(ctx.validatorCount, 2)),
      // { kind: "median", minInputs: Math.floor(2 * ctx.validatorCount / 3) },
      { kind: "latched-median" },
    ];
    const adversaryTypes: Exclude<ValidatorType, "honest">[] = ["malicious", "pushy-max"];
    const fractions = [0.10, 0.33, 0.49];

    const configs: SimulationConfig[] = [];
    for (const agg of aggregators) {
      configs.push(makeConfig(ctx, [], agg));

      for (const type of adversaryTypes) {
        if (!isCompatibleWithAggregator(type, agg.kind)) continue;
        for (const frac of fractions) {
          const specs: GroupSpec[] = [{ type, fraction: frac, params: COMPARISON_PARAMS }];
          configs.push(makeConfig(ctx, specs, agg));
        }
      }
    }

    console.log(`  Grid: ${aggregators.length} engines × (1 honest + ${adversaryTypes.length} types × ${fractions.length} fractions) = ${configs.length} configs`);
    console.log(`  Comparison knobs: maliciousQuoteBias=${(COMPARISON_PARAMS.maliciousQuoteBias * 100).toFixed(1)}%, pushyQuoteBias=${(COMPARISON_PARAMS.pushyQuoteBias * 100).toFixed(1)}%, delayBlocks=${COMPARISON_PARAMS.delayBlocks}, driftQuoteStep=${(COMPARISON_PARAMS.driftQuoteStep * 100).toFixed(1)}%`);
    return runBatch(configs, priceSource, outputDir, threadCount);
  },
};

export function listScenarios(): string[] {
  return Object.keys(scenarios);
}

/** Scenarios whose simulation logic is tied to a specific date range, e.g.
 *  the all-venues intersection window. `main.ts` consults this map BEFORE
 *  calling `loadPriceSource` and overrides the CLI `--start-date`/`--end-date`
 *  flags so the loaded price data matches what the scenario will actually
 *  use. */
export const SCENARIO_DATE_RANGES: Record<string, { startDate: string; endDate: string }> = {
  "all-venues-honest": ENTIRE_VENUES_HISTORY,
};

// Re-export for callers (main.ts) that need to spell the default ctx.
export { DEFAULT_CONFIG, DEFAULT_PRICE_SOURCE, DEFAULT_VALIDATOR_COUNT };

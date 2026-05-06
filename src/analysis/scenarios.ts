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
  withholderDirection: "up",
  biasInjectorDirection: "up",
  overshootRatchetDirection: "up",
  overshootRatchetCeilingBumps: 200,
  stealthWithholderDirection: "up",
  stealthAbstainThreshold: 0.0005,
  convergentCabalDirection: "up",
  convergentCabalTrendBlocks: 30,
  convergentCabalTrendMagnitude: 0.0030,
  convergentCabalCeilingBumps: 200,
  inbandShifterDirection: "up",
  inbandShifterQuoteBias: 0.04,
  inbandShifterCeilingBumps: 200,
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

// ── Tournament harness ──────────────────────────────────────────────────────
// See TOURNAMENT.md for the methodology. Each round runs the same attacker
// mix against System A (nudge) and System B (median) under identical seeds /
// data / placement, and the only difference between the two sims is the
// aggregator config. Defenses earned by either system get plugged in via
// `systemA` / `systemB` overrides — the harness itself stays neutral.
//
// Usage from a scenario:
//   const specs: GroupSpec[] = [{ type: "withholder", fraction: 1/3, params: {...} }];
//   const configs = tournamentRoundConfigs(ctx, specs, "withholder-up", systemA, systemB);
//   return runBatch(configs, priceSource, outputDir, threadCount);
function tournamentRoundConfigs(
  ctx: ScenarioCtx,
  attackerSpecs: GroupSpec[],
  attackerLabel: string,
  systemA: AggregatorConfig,
  systemB: AggregatorConfig,
): SimulationConfig[] {
  return [
    makeConfig(ctx, attackerSpecs, `[A nudge] ${attackerLabel}`,  systemA),
    makeConfig(ctx, attackerSpecs, `[B median] ${attackerLabel}`, systemB),
  ];
}

/** Frozen baseline configs — never mutated. Used by round-N scenarios that
 *  want the original undefended system for evidence purposes. */
const TOURNAMENT_SYSTEM_A_BASELINE = (ctx: ScenarioCtx): AggregatorConfig =>
  ({ kind: "nudge", epsilon: ctx.defaultEpsilon });
const TOURNAMENT_SYSTEM_B_BASELINE: AggregatorConfig =
  { kind: "median" }; // minInputs defaults to floor(2N/3)+1 in the engine

/** Current state of the systems including all committed defenses from prior
 *  rounds. Round-N scenarios use these so each new attacker faces the
 *  fully-hardened systems. See TOURNAMENT.md "defense ledger" sections. */
const TOURNAMENT_SYSTEM_A_CURRENT = TOURNAMENT_SYSTEM_A_BASELINE;
const TOURNAMENT_SYSTEM_B_CURRENT: AggregatorConfig = {
  // Defenses committed in B's ledger (defense-4 was rejected, see TOURNAMENT.md):
  //   #1: wideband confidence tracking (5% goodBand) with permanent exclusion
  //   #2: freeze-aware callback (absent-penalty fires on freeze blocks too)
  //   #3: attributed absence detection (defense-5 if accepted) — only
  //       penalise self-abstain, never penalise validators dropped by a
  //       malicious author
  kind: "median",
  confidence: "wideband-attributed",
  permanentExclusion: true,
};

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
    // Per-validator-index type vector. Cheap to always emit (N strings) and
    // unconditionally useful for any client that wants per-validator labels
    // — including the Confidence tab in the UI.
    const validatorTypes: ValidatorType[] = [];
    for (const g of result.config.validators) {
      for (let i = 0; i < g.count; i++) validatorTypes.push(g.type);
    }
    meta = {
      config: result.config,
      summary: result.summary,
      blockCount: info.blockCount,
      chunkCount: info.chunkCount,
      timeRange: info.timeRange,
      chunkTimeRanges: info.chunkTimeRanges,
      dir: dirName,
      validatorTypes,
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
      { kind: "median", minInputs: Math.floor(2 * ctx.validatorCount / 3) },
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

  /**
   * Withholder demonstration. The `withholder` validator is a coordinated
   * 1/3-cabal that abstains *only* when honest publication would push the
   * oracle in a chosen direction. At 1/3 saturation this trips the default
   *  median minInputs = 2N/3 + 1 freeze-branch — but selectively, so the
   * oracle ratchets only against the attack direction.
   *
   * Compares against existing 1/3-cabals (malicious, pushy — bounded by
   * jitter; noop — full freeze). Confidence tracking is OFF here so the
   * raw attack is visible. See `withholder-vs-confidence` for the defended
   * version.
   */
  async "withholder-baseline"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: withholder-baseline]`);
    const f = 1 / 3;
    const configs: SimulationConfig[] = [
      makeConfig(ctx, [], "baseline-honest"),
      makeConfig(ctx, [{ type: "malicious", fraction: f }], "malicious-1/3"),
      makeConfig(ctx, [{ type: "pushy",     fraction: f }], "pushy-1/3"),
      makeConfig(ctx, [{ type: "noop",      fraction: f }], "noop-1/3"),
      makeConfig(ctx, [{ type: "withholder", fraction: f, params: { withholderDirection: "up" } }],
                 "withholder-up-1/3"),
      makeConfig(ctx, [{ type: "withholder", fraction: f, params: { withholderDirection: "down" } }],
                 "withholder-down-1/3"),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /**
   * Same threat model as `withholder-baseline`, but with the default
   * confidence-update callback wired into the median aggregator. After ~100
   * blocks of selective abstention, withholders hit confidence 0 and are
   * permanently excluded. The active set drops to the honest 200 and the
   * rescaled minInputs (~134) lets the chain continue cleanly.
   */
  async "withholder-vs-confidence"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: withholder-vs-confidence]`);
    const f = 1 / 3;
    const aggWithConfidence: AggregatorConfig = {
      kind: "median",
      confidence: "default",
      permanentExclusion: true,
    };
    const configs: SimulationConfig[] = [
      makeConfig(ctx, [], "baseline-honest", aggWithConfidence),
      makeConfig(ctx, [{ type: "malicious", fraction: f }], "malicious-1/3", aggWithConfidence),
      makeConfig(ctx, [{ type: "pushy",     fraction: f }], "pushy-1/3",     aggWithConfidence),
      makeConfig(ctx, [{ type: "noop",      fraction: f }], "noop-1/3",      aggWithConfidence),
      makeConfig(ctx, [{ type: "withholder", fraction: f, params: { withholderDirection: "up" } }],
                 "withholder-up-1/3", aggWithConfidence),
      makeConfig(ctx, [{ type: "withholder", fraction: f, params: { withholderDirection: "down" } }],
                 "withholder-down-1/3", aggWithConfidence),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /**
   * Sanity check: confidence tracking should NOT punish honest validators
   * even at higher-than-default jitter, and should expose how it treats
   * `delayed` validators (honest intent, stale observation). Useful for
   * spotting bad parameter choices in the default callback.
   */
  async "confidence-stress"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: confidence-stress]`);
    const aggWithConfidence: AggregatorConfig = {
      kind: "median",
      confidence: "default",
      permanentExclusion: true,
    };
    const highJitter: ValidatorPriceSource = { ...ctx.priceSource, jitterStdDev: 0.005 };
    const ctxHigh: ScenarioCtx = { ...ctx, priceSource: highJitter };
    const configs: SimulationConfig[] = [
      makeConfig(ctx,     [], "100% honest, default jitter", aggWithConfidence),
      makeConfig(ctxHigh, [], "100% honest, 5x jitter",      aggWithConfidence),
      makeConfig(ctx,     [{ type: "delayed", fraction: 1 / 3 }], "33% delayed", aggWithConfidence),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /**
   * Tournament Round 0. The withholder attack against both contender
   * aggregators in the BASELINE configuration (no defenses on either side).
   *
   * The expected discriminator: median is broken (criterion 1 + 3, ratchets
   * monotonically against the attack direction); nudge is bounded (no
   * minInputs threshold to exploit, abstain just means "no bump", which is
   * normal for nudge).
   *
   * See TOURNAMENT.md and `tournament-runs/round-0-withholder/`.
   */
  async "tournament-round-0"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: tournament-round-0 — withholder vs A & B baselines]`);
    const f = 1 / 3;
    const specsUp:   GroupSpec[] = [{ type: "withholder", fraction: f, params: { withholderDirection: "up" } }];
    const specsDown: GroupSpec[] = [{ type: "withholder", fraction: f, params: { withholderDirection: "down" } }];
    const A = TOURNAMENT_SYSTEM_A_BASELINE(ctx);
    const B = TOURNAMENT_SYSTEM_B_BASELINE;
    const configs: SimulationConfig[] = [
      ...tournamentRoundConfigs(ctx, [],         "honest-baseline",   A, B),
      ...tournamentRoundConfigs(ctx, specsUp,    "withholder-up",     A, B),
      ...tournamentRoundConfigs(ctx, specsDown,  "withholder-down",   A, B),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /**
   * Tournament Round 1. The `bias-injector` attacker against both contender
   * aggregators in their BASELINE configuration (no defenses on either side).
   *
   * The attacker (see `BiasInjectorValidator` in src/sim/malicious.ts) is
   * a 1/3-cabal that ratchets the oracle in a chosen direction by combining:
   *   - Quote mode: withholder-style abstention on against-direction blocks
   *     (carries forward the round-0 attack on median's minInputs gate).
   *   - Nudge mode: pool-poisoning input + asymmetric author-side scheme
   *     (amplify in-direction blocks; FREEZE against-direction blocks). This
   *     is the new mechanism — the cabal as author skips correction work
   *     1/3 of the time, biasing the equilibrium oracle position.
   *
   * Predicted outcome: median is broken for the same reasons as round 0
   * (criterion 1 + 3). Nudge: bounded under flat or balanced data, but
   * the asymmetric-freeze leg interacts with the data window's drift —
   * if 2025-10-10 → 2025-10-20 has a sustained against-bias trend, the
   * attack could trip criterion 1.
   *
   * See TOURNAMENT.md and `tournament-runs/round-1-bias-injector/`.
   */
  async "tournament-round-1"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: tournament-round-1 — bias-injector vs A & B baselines]`);
    const f = 1 / 3;
    const specsUp:   GroupSpec[] = [{ type: "bias-injector", fraction: f, params: { biasInjectorDirection: "up" } }];
    const specsDown: GroupSpec[] = [{ type: "bias-injector", fraction: f, params: { biasInjectorDirection: "down" } }];
    const A = TOURNAMENT_SYSTEM_A_BASELINE(ctx);
    const B = TOURNAMENT_SYSTEM_B_BASELINE;
    const configs: SimulationConfig[] = [
      ...tournamentRoundConfigs(ctx, [],         "honest-baseline",      A, B),
      ...tournamentRoundConfigs(ctx, specsUp,    "bias-injector-up",     A, B),
      ...tournamentRoundConfigs(ctx, specsDown,  "bias-injector-down",   A, B),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /**
   * Tournament Round 2. The `overshoot-ratchet` attacker against both
   * contender aggregators in their BASELINE configuration.
   *
   * Designed to target System A (nudge) — the asymmetric-abstention class
   * (round 0/1) breaks median but only bends nudge. OvershootRatchet's new
   * mechanism is to inject bias-direction movement on EVERY cabal-authored
   * block (not just with-bias real motion). On with-bias blocks the cabal
   * activates 200 honest + 100 cabal pool-poison bumps for a maxBlockDelta
   * overshoot AND honest authors find no correction-direction bumps in the
   * pool to draw on (key seam: when real moves up, honest emit Up, so the
   * Down pool is empty when oracle has overshot up). On against-bias blocks
   * the cabal still activates its 100 pool-poison bumps for a 1/3
   * maxBlockDelta injection. A ceiling-based freeze leg locks in gains when
   * cumulative overshoot is large, avoiding giveback.
   *
   * Predicted outcome: median is broken on the same axes as round 0/1 (the
   * quote leg is byte-equivalent to withholder). Nudge: the new injection-
   * even-on-against-bias-blocks mechanism gives a stronger, more persistent
   * ratchet than bias-injector. Whether this trips criterion 1 (mean dev > 5%)
   * on the 10-day window depends on real DOT directional asymmetry. If real
   * trends with the bias direction, deviation accumulates uncorrectably.
   *
   * See TOURNAMENT.md and `tournament-runs/round-2-overshoot-ratchet/`.
   */
  async "tournament-round-2"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: tournament-round-2 — overshoot-ratchet vs A & hardened B (defense #1)]`);
    const f = 1 / 3;
    const specsUp:   GroupSpec[] = [{ type: "overshoot-ratchet", fraction: f, params: { overshootRatchetDirection: "up" } }];
    const specsDown: GroupSpec[] = [{ type: "overshoot-ratchet", fraction: f, params: { overshootRatchetDirection: "down" } }];
    // After defense-2 was committed, B carries wideband confidence tracking.
    // A is still at baseline (no defenses earned yet).
    const A = TOURNAMENT_SYSTEM_A_CURRENT(ctx);
    const B = TOURNAMENT_SYSTEM_B_CURRENT;
    const configs: SimulationConfig[] = [
      ...tournamentRoundConfigs(ctx, [],         "honest-baseline",         A, B),
      ...tournamentRoundConfigs(ctx, specsUp,    "overshoot-ratchet-up",    A, B),
      ...tournamentRoundConfigs(ctx, specsDown,  "overshoot-ratchet-down",  A, B),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /**
   * Defense-ladder candidate #1 for System B (median).
   *
   * After two consecutive discriminating rounds (round 0 withholder, round 1
   * bias-injector) where median was broken by selective abstention defeating
   * the 2N/3+1 minInputs gate, we apply the FIRST defense from B's ladder:
   * confidence tracking with permanent exclusion (already implemented).
   *
   * Mechanism: each block, the median aggregator runs a callback that
   * decrements the confidence of validators absent from the inherent
   * (`-ABSENT_PENALTY`). After ~100 abstain-blocks the cabal hits 0 and is
   * permanently excluded. The active set shrinks to honest 200; the rescaled
   * `floor(2/3 · 200)+1 = 134` minInputs is easily met → chain unfreezes.
   *
   * The same withholder + bias-injector attackers from rounds 0/1 are re-run
   * here against the hardened B (and an unchanged A baseline for reference).
   * If hardened B holds (mean dev < 5%, max consec < 10% of blocks), defense
   * #1 enters B's permanent ledger and round 2 starts with hardened B.
   */
  /**
   * Defense-ladder candidate #2 for System B (median).
   *
   * Defense #1 (1% goodBand confidence tracking) was rejected because it
   * false-positived honest validators on `random-venue` observation mode.
   * This widens the goodBand to 5%, large enough to absorb cross-venue
   * dispersion while still rejecting attacker bias magnitudes (withholder
   * doesn't submit bad quotes — it ABSTAINS, so absent-penalty handles it).
   *
   * Same scenario layout as defense-1: re-test withholder + bias-injector
   * against hardened B + reference baseline A.
   */
  /**
   * Tournament re-run at the STRICT Polkadot threshold (byzantine < N/3).
   *
   * The first 5 rounds tested at fraction = 1/3 = 100/300, which JS resolves
   * to exactly 100 byzantine. The minInputs default `floor(2N/3) + 1 = 201`
   * is calibrated for byzantine ≤ 99, so testing at 100 sits one past the
   * protocol's stated assumption ("≥ 2/3 + 1 honest" → byzantine ≤ 99).
   *
   * This scenario runs all 6 attacker classes (each in {up, down}) at the
   * corrected fraction 99/300 against:
   *   - A baseline (nudge, minInputs=0) — should still hold
   *   - B baseline (median, no defenses) — should now hold against the
   *     abstention class because 201 honest meet minInputs even with
   *     all 99 cabal members abstaining
   *   - B hardened-v3 (wideband-attributed confidence) — should hold against
   *     all classes; the question is whether inband-shifter still triggers
   *     the venue-dispersion cascading exclusion at this lower fraction
   */
  async "tournament-rerun-strict-threshold"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: tournament-rerun-strict-threshold — all attackers at 99/300 byzantine]`);
    const f = 99 / 300; // strictly below 1/3
    const A = TOURNAMENT_SYSTEM_A_BASELINE(ctx);
    const B_BASELINE = TOURNAMENT_SYSTEM_B_BASELINE;
    const B_HARDENED: AggregatorConfig = {
      kind: "median",
      confidence: "wideband-attributed",
      permanentExclusion: true,
    };
    const wUp:  GroupSpec[] = [{ type: "withholder",         fraction: f, params: { withholderDirection: "up" } }];
    const wDn:  GroupSpec[] = [{ type: "withholder",         fraction: f, params: { withholderDirection: "down" } }];
    const biUp: GroupSpec[] = [{ type: "bias-injector",      fraction: f, params: { biasInjectorDirection: "up" } }];
    const biDn: GroupSpec[] = [{ type: "bias-injector",      fraction: f, params: { biasInjectorDirection: "down" } }];
    const orUp: GroupSpec[] = [{ type: "overshoot-ratchet",  fraction: f, params: { overshootRatchetDirection: "up" } }];
    const orDn: GroupSpec[] = [{ type: "overshoot-ratchet",  fraction: f, params: { overshootRatchetDirection: "down" } }];
    const swUp: GroupSpec[] = [{ type: "stealth-withholder", fraction: f, params: { stealthWithholderDirection: "up" } }];
    const swDn: GroupSpec[] = [{ type: "stealth-withholder", fraction: f, params: { stealthWithholderDirection: "down" } }];
    const ccUp: GroupSpec[] = [{ type: "convergent-cabal",   fraction: f, params: { convergentCabalDirection: "up" } }];
    const ccDn: GroupSpec[] = [{ type: "convergent-cabal",   fraction: f, params: { convergentCabalDirection: "down" } }];
    const ibUp: GroupSpec[] = [{ type: "inband-shifter",     fraction: f, params: { inbandShifterDirection: "up" } }];
    const ibDn: GroupSpec[] = [{ type: "inband-shifter",     fraction: f, params: { inbandShifterDirection: "down" } }];

    // Helper: 3-system tuple of configs (A, B baseline, B hardened) for one attacker.
    const triple = (specs: GroupSpec[], label: string): SimulationConfig[] => [
      makeConfig(ctx, specs, `[A nudge] ${label}`,         A),
      makeConfig(ctx, specs, `[B baseline] ${label}`,      B_BASELINE),
      // makeConfig(ctx, specs, `[B hardened-v3] ${label}`,   B_HARDENED),
    ];

    const configs: SimulationConfig[] = [
      ...triple([],   "honest-baseline"),
      ...triple(wUp,  "withholder-up"),
      ...triple(wDn,  "withholder-down"),
      ...triple(biUp, "bias-injector-up"),
      ...triple(biDn, "bias-injector-down"),
      ...triple(orUp, "overshoot-ratchet-up"),
      ...triple(orDn, "overshoot-ratchet-down"),
      ...triple(swUp, "stealth-withholder-up"),
      ...triple(swDn, "stealth-withholder-down"),
      ...triple(ccUp, "convergent-cabal-up"),
      ...triple(ccDn, "convergent-cabal-down"),
      ...triple(ibUp, "inband-shifter-up"),
      ...triple(ibDn, "inband-shifter-down"),
    ];
    console.log(`  Total sims: ${configs.length} (13 attacker variants × 3 systems)`);
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /**
   * Defense-ladder candidate #6 for System B (median).
   *
   * Round 5 (`inband-shifter`) demonstrated that confidence-based defenses
   * have a structural conflict with random-venue observation: any goodBand
   * tight enough to catch attackers also false-positives honest validators
   * during real-world volatile price moves, leading to cascading exclusion
   * and oracle collapse.
   *
   * Defense-6 abandons per-validator confidence and uses **k-trim by value**.
   * Median(k=0.4) drops top/bottom 40% of quotes by value before computing
   * the median. With 1/3 cabal placed at one extreme (e.g. lastPrice * 0.96),
   * trimming 40% from each tail removes all 100 cabal quotes plus 20 honest
   * outliers from each side, leaving the middle ~140 honest. Median over
   * those 140 = honest cluster ≈ real. No per-validator state, so no
   * exclusion cascade.
   *
   * Tradeoff: k=0.4 trims aggressively, reducing the effective sample size.
   * Per-block variance is higher than untrimmed median in honest baseline,
   * but should still be well-bounded.
   */
  async "tournament-defense-6-ktrim"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: tournament-defense-6-ktrim — k-trim instead of confidence]`);
    const f = 1 / 3;
    const A = TOURNAMENT_SYSTEM_A_BASELINE(ctx);
    const B_HARDENED_v5: AggregatorConfig = {
      kind: "median",
      k: 0.4,
      // No confidence tracking. permanentExclusion irrelevant.
    };
    const wUp:  GroupSpec[] = [{ type: "withholder",         fraction: f, params: { withholderDirection: "up" } }];
    const wDn:  GroupSpec[] = [{ type: "withholder",         fraction: f, params: { withholderDirection: "down" } }];
    const biUp: GroupSpec[] = [{ type: "bias-injector",      fraction: f, params: { biasInjectorDirection: "up" } }];
    const biDn: GroupSpec[] = [{ type: "bias-injector",      fraction: f, params: { biasInjectorDirection: "down" } }];
    const swUp: GroupSpec[] = [{ type: "stealth-withholder", fraction: f, params: { stealthWithholderDirection: "up" } }];
    const swDn: GroupSpec[] = [{ type: "stealth-withholder", fraction: f, params: { stealthWithholderDirection: "down" } }];
    const ccUp: GroupSpec[] = [{ type: "convergent-cabal",   fraction: f, params: { convergentCabalDirection: "up" } }];
    const ccDn: GroupSpec[] = [{ type: "convergent-cabal",   fraction: f, params: { convergentCabalDirection: "down" } }];
    const ibUp: GroupSpec[] = [{ type: "inband-shifter",     fraction: f, params: { inbandShifterDirection: "up" } }];
    const ibDn: GroupSpec[] = [{ type: "inband-shifter",     fraction: f, params: { inbandShifterDirection: "down" } }];
    const configs: SimulationConfig[] = [
      ...tournamentRoundConfigs(ctx, [],   "honest-baseline",            A, B_HARDENED_v5),
      ...tournamentRoundConfigs(ctx, wUp,  "withholder-up",              A, B_HARDENED_v5),
      ...tournamentRoundConfigs(ctx, wDn,  "withholder-down",            A, B_HARDENED_v5),
      ...tournamentRoundConfigs(ctx, biUp, "bias-injector-up",           A, B_HARDENED_v5),
      ...tournamentRoundConfigs(ctx, biDn, "bias-injector-down",         A, B_HARDENED_v5),
      ...tournamentRoundConfigs(ctx, swUp, "stealth-withholder-up",      A, B_HARDENED_v5),
      ...tournamentRoundConfigs(ctx, swDn, "stealth-withholder-down",    A, B_HARDENED_v5),
      ...tournamentRoundConfigs(ctx, ccUp, "convergent-cabal-up",        A, B_HARDENED_v5),
      ...tournamentRoundConfigs(ctx, ccDn, "convergent-cabal-down",      A, B_HARDENED_v5),
      ...tournamentRoundConfigs(ctx, ibUp, "inband-shifter-up",          A, B_HARDENED_v5),
      ...tournamentRoundConfigs(ctx, ibDn, "inband-shifter-down",        A, B_HARDENED_v5),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /**
   * Defense-ladder candidate #5 for System B (median).
   *
   * Defense-4 (strict 5× absent penalty) was rejected because honest
   * validators were getting -0.05 every time a cabal author dropped them
   * from the inherent — eventually decaying to permanent exclusion.
   *
   * Defense-5 keeps the 5× absent penalty (essential for closing the
   * round-4 reward arbitrage seam) but attributes absence: the penalty
   * only fires if the validator self-abstained (kind="abstain" in
   * `inputs`, or didn't submit at all). If the validator submitted a real
   * quote/nudge in `inputs` but the author dropped them, no penalty.
   *
   * Re-test all five attackers (withholder, bias-injector, stealth-
   * withholder, convergent-cabal — each up/down) against B-hardened-v3.
   */
  async "tournament-defense-5-attributed"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: tournament-defense-5-attributed — re-test all attackers vs B with attributed absence]`);
    const f = 1 / 3;
    const A = TOURNAMENT_SYSTEM_A_BASELINE(ctx);
    const B_HARDENED_v4: AggregatorConfig = {
      kind: "median",
      confidence: "wideband-attributed",
      permanentExclusion: true,
    };
    const wUp:  GroupSpec[] = [{ type: "withholder",         fraction: f, params: { withholderDirection: "up" } }];
    const wDn:  GroupSpec[] = [{ type: "withholder",         fraction: f, params: { withholderDirection: "down" } }];
    const biUp: GroupSpec[] = [{ type: "bias-injector",      fraction: f, params: { biasInjectorDirection: "up" } }];
    const biDn: GroupSpec[] = [{ type: "bias-injector",      fraction: f, params: { biasInjectorDirection: "down" } }];
    const swUp: GroupSpec[] = [{ type: "stealth-withholder", fraction: f, params: { stealthWithholderDirection: "up" } }];
    const swDn: GroupSpec[] = [{ type: "stealth-withholder", fraction: f, params: { stealthWithholderDirection: "down" } }];
    const ccUp: GroupSpec[] = [{ type: "convergent-cabal",   fraction: f, params: { convergentCabalDirection: "up" } }];
    const ccDn: GroupSpec[] = [{ type: "convergent-cabal",   fraction: f, params: { convergentCabalDirection: "down" } }];
    const configs: SimulationConfig[] = [
      ...tournamentRoundConfigs(ctx, [],   "honest-baseline",        A, B_HARDENED_v4),
      ...tournamentRoundConfigs(ctx, wUp,  "withholder-up",          A, B_HARDENED_v4),
      ...tournamentRoundConfigs(ctx, wDn,  "withholder-down",        A, B_HARDENED_v4),
      ...tournamentRoundConfigs(ctx, biUp, "bias-injector-up",       A, B_HARDENED_v4),
      ...tournamentRoundConfigs(ctx, biDn, "bias-injector-down",     A, B_HARDENED_v4),
      ...tournamentRoundConfigs(ctx, swUp, "stealth-withholder-up",  A, B_HARDENED_v4),
      ...tournamentRoundConfigs(ctx, swDn, "stealth-withholder-down", A, B_HARDENED_v4),
      ...tournamentRoundConfigs(ctx, ccUp, "convergent-cabal-up",    A, B_HARDENED_v4),
      ...tournamentRoundConfigs(ctx, ccDn, "convergent-cabal-down",  A, B_HARDENED_v4),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /**
   * Defense-ladder candidate #4 for System B (median).
   *
   * Round 4's `convergent-cabal` exposed the symmetric reward/penalty seam
   * in defenses 1+2: `+REWARD_DELTA == ABSENT_PENALTY == 0.01`, so a cabal
   * abstaining < 50% of blocks has non-decreasing long-run confidence and
   * is never excluded.
   *
   * Defense #4 breaks the symmetry: STRICT_ABSENT_PENALTY = 0.05 (5× the
   * reward). Breakeven abstain rate drops to ~16.7%; any cabal abstaining
   * above that decays toward exclusion.
   *
   * Re-test all five prior attackers (withholder, bias-injector,
   * stealth-withholder, convergent-cabal — each up/down) against the
   * upgraded hardened B.
   */
  async "tournament-defense-4-strict"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: tournament-defense-4-strict — re-test all attackers vs B with strict absent penalty]`);
    const f = 1 / 3;
    const A = TOURNAMENT_SYSTEM_A_BASELINE(ctx);
    const B_HARDENED_v3: AggregatorConfig = {
      kind: "median",
      confidence: "wideband-strict",
      permanentExclusion: true,
    };
    const wUp:  GroupSpec[] = [{ type: "withholder",         fraction: f, params: { withholderDirection: "up" } }];
    const wDn:  GroupSpec[] = [{ type: "withholder",         fraction: f, params: { withholderDirection: "down" } }];
    const biUp: GroupSpec[] = [{ type: "bias-injector",      fraction: f, params: { biasInjectorDirection: "up" } }];
    const biDn: GroupSpec[] = [{ type: "bias-injector",      fraction: f, params: { biasInjectorDirection: "down" } }];
    const swUp: GroupSpec[] = [{ type: "stealth-withholder", fraction: f, params: { stealthWithholderDirection: "up" } }];
    const swDn: GroupSpec[] = [{ type: "stealth-withholder", fraction: f, params: { stealthWithholderDirection: "down" } }];
    const ccUp: GroupSpec[] = [{ type: "convergent-cabal",   fraction: f, params: { convergentCabalDirection: "up" } }];
    const ccDn: GroupSpec[] = [{ type: "convergent-cabal",   fraction: f, params: { convergentCabalDirection: "down" } }];
    const configs: SimulationConfig[] = [
      ...tournamentRoundConfigs(ctx, [],   "honest-baseline",        A, B_HARDENED_v3),
      ...tournamentRoundConfigs(ctx, wUp,  "withholder-up",          A, B_HARDENED_v3),
      ...tournamentRoundConfigs(ctx, wDn,  "withholder-down",        A, B_HARDENED_v3),
      ...tournamentRoundConfigs(ctx, biUp, "bias-injector-up",       A, B_HARDENED_v3),
      ...tournamentRoundConfigs(ctx, biDn, "bias-injector-down",     A, B_HARDENED_v3),
      ...tournamentRoundConfigs(ctx, swUp, "stealth-withholder-up",  A, B_HARDENED_v3),
      ...tournamentRoundConfigs(ctx, swDn, "stealth-withholder-down", A, B_HARDENED_v3),
      ...tournamentRoundConfigs(ctx, ccUp, "convergent-cabal-up",    A, B_HARDENED_v3),
      ...tournamentRoundConfigs(ctx, ccDn, "convergent-cabal-down",  A, B_HARDENED_v3),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /**
   * Defense-ladder candidate #3 for System B (median).
   *
   * Round 3's `stealth-withholder` exploited a structural seam: the median
   * aggregator's freeze branch returned early WITHOUT calling the confidence
   * callback, so a cabal that aligned every abstain block with a freeze
   * block accrued zero absent-penalty.
   *
   * Defense-3 plugs the seam by extending the `ConfidenceUpdate` signature
   * with a `priceUpdated: boolean` flag and calling the callback on BOTH
   * branches (success and freeze). The wideband callback now penalises
   * absences regardless of whether a median was computed; the goodBand
   * reward path is skipped on freeze (no median to compare against).
   *
   * Re-test all four prior attackers (withholder, bias-injector,
   * stealth-withholder up/down each) against the upgraded hardened B.
   */
  async "tournament-defense-3-freeze-aware"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: tournament-defense-3-freeze-aware — re-test all attackers vs B with freeze-aware confidence]`);
    const f = 1 / 3;
    const A = TOURNAMENT_SYSTEM_A_BASELINE(ctx);
    const B_HARDENED_v2: AggregatorConfig = {
      kind: "median",
      confidence: "wideband",
      permanentExclusion: true,
    };
    const wUp:  GroupSpec[] = [{ type: "withholder",        fraction: f, params: { withholderDirection: "up" } }];
    const wDn:  GroupSpec[] = [{ type: "withholder",        fraction: f, params: { withholderDirection: "down" } }];
    const biUp: GroupSpec[] = [{ type: "bias-injector",     fraction: f, params: { biasInjectorDirection: "up" } }];
    const biDn: GroupSpec[] = [{ type: "bias-injector",     fraction: f, params: { biasInjectorDirection: "down" } }];
    const swUp: GroupSpec[] = [{ type: "stealth-withholder", fraction: f, params: { stealthWithholderDirection: "up" } }];
    const swDn: GroupSpec[] = [{ type: "stealth-withholder", fraction: f, params: { stealthWithholderDirection: "down" } }];
    const configs: SimulationConfig[] = [
      ...tournamentRoundConfigs(ctx, [],   "honest-baseline",            A, B_HARDENED_v2),
      ...tournamentRoundConfigs(ctx, wUp,  "withholder-up",              A, B_HARDENED_v2),
      ...tournamentRoundConfigs(ctx, wDn,  "withholder-down",            A, B_HARDENED_v2),
      ...tournamentRoundConfigs(ctx, biUp, "bias-injector-up",           A, B_HARDENED_v2),
      ...tournamentRoundConfigs(ctx, biDn, "bias-injector-down",         A, B_HARDENED_v2),
      ...tournamentRoundConfigs(ctx, swUp, "stealth-withholder-up",      A, B_HARDENED_v2),
      ...tournamentRoundConfigs(ctx, swDn, "stealth-withholder-down",    A, B_HARDENED_v2),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  async "tournament-defense-2-wideband"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: tournament-defense-2-wideband — wideband confidence vs rounds 0/1 attackers]`);
    const f = 1 / 3;
    const A = TOURNAMENT_SYSTEM_A_BASELINE(ctx);
    const B_HARDENED_v2: AggregatorConfig = {
      kind: "median",
      confidence: "wideband",
      permanentExclusion: true,
    };
    const wUp:  GroupSpec[] = [{ type: "withholder",    fraction: f, params: { withholderDirection: "up" } }];
    const wDn:  GroupSpec[] = [{ type: "withholder",    fraction: f, params: { withholderDirection: "down" } }];
    const biUp: GroupSpec[] = [{ type: "bias-injector", fraction: f, params: { biasInjectorDirection: "up" } }];
    const biDn: GroupSpec[] = [{ type: "bias-injector", fraction: f, params: { biasInjectorDirection: "down" } }];
    const configs: SimulationConfig[] = [
      ...tournamentRoundConfigs(ctx, [],   "honest-baseline",    A, B_HARDENED_v2),
      ...tournamentRoundConfigs(ctx, wUp,  "withholder-up",      A, B_HARDENED_v2),
      ...tournamentRoundConfigs(ctx, wDn,  "withholder-down",    A, B_HARDENED_v2),
      ...tournamentRoundConfigs(ctx, biUp, "bias-injector-up",   A, B_HARDENED_v2),
      ...tournamentRoundConfigs(ctx, biDn, "bias-injector-down", A, B_HARDENED_v2),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /**
   * Tournament Round 3. The `stealth-withholder` attacker against System A
   * (nudge baseline) and System B (median + wideband-confidence — defense #1).
   *
   * Designed against the SEAM in defense #1: the wideband-confidence callback
   * is gated behind the aggregator's `quotes.length < effectiveMinInputs`
   * early-return. On a freeze block, `updateConfidence` is NEVER called →
   * absent-penalty doesn't fire. Round 0/1 attackers were caught only because
   * per-validator jitter spread the abstain decision across the cabal — on
   * blocks where a fraction of cabal abstained but the inherent still met
   * minInputs, the absent fraction got penalised. The round-3 attacker
   * eliminates that exposure by:
   *
   *   1. Running with `priceSource = { kind: "cross-venue", jitterStdDev: 0 }`.
   *      All 100 cabal members observe the IDENTICAL real price every block.
   *      Their abstain/quote decision is deterministically synchronised.
   *
   *   2. Abstaining only when the observation pushes the oracle in the bias
   *      direction by ≥ `stealthAbstainThreshold` (default 0.0005 = 0.05% of
   *      lastPrice). All 100 cabal members agree → simultaneous abstain →
   *      300-100 = 200 quotes < 201 minInputs → freeze. Confidence not
   *      updated. No penalty.
   *
   *   3. On non-abstain blocks (real ≤ lastPrice·(1+threshold) for "up"),
   *      submitting an honest quote near the median → +REWARD_DELTA on every
   *      such block. Confidence drifts to 1.0 and pins.
   *
   * Quote-leg net effect on B: every block where real has drifted >0.05%
   * above oracle is frozen. Oracle behaviour during sustained up-trends:
   * pinned at the trend-start price. Down-runs and flat periods catch up
   * normally (median ≈ real). Cabal NEVER excluded.
   *
   * Nudge-leg vs A: pool-poison + overshoot-ratchet author logic. Same
   * structural ceiling we hit in round 2 — expected ~1% mean dev on A.
   *
   * Predicted outcomes: A bounded; B BROKEN with high probability on
   * criterion 3 (long stretches of `deviationPct ≥ 0.5%` whenever real
   * up-trends exceed 0.5% over multiple blocks); criterion 1 may also trip
   * if 2025-10-10→20 has sustained up-runs.
   *
   * If B does NOT break under this attack, that's strong evidence the
   * defense-#1 + median combo is genuinely robust to a much harder attack
   * class. If A does break (unexpected), it'd be an order-of-magnitude
   * surprise relative to the round-2 result.
   */
  async "tournament-round-3"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: tournament-round-3 — stealth-withholder vs A & hardened B (defense #1)]`);
    const f = 1 / 3;
    // The cabal MUST observe with zero jitter so all 100 members evaluate
    // the suppress predicate identically. cross-venue with jitterStdDev=0
    // → every cabal member sees the exact real price. This is the linchpin
    // of the freeze-skips-callback bypass.
    const cabalPS: ValidatorPriceSource = { kind: "cross-venue", jitterStdDev: 0 };
    const specsUp: GroupSpec[] = [{
      type: "stealth-withholder",
      fraction: f,
      priceSource: cabalPS,
      params: { stealthWithholderDirection: "up", stealthAbstainThreshold: 0.0005 },
    }];
    const specsDown: GroupSpec[] = [{
      type: "stealth-withholder",
      fraction: f,
      priceSource: cabalPS,
      params: { stealthWithholderDirection: "down", stealthAbstainThreshold: 0.0005 },
    }];
    const A = TOURNAMENT_SYSTEM_A_CURRENT(ctx);
    const B = TOURNAMENT_SYSTEM_B_CURRENT;
    const configs: SimulationConfig[] = [
      ...tournamentRoundConfigs(ctx, [],         "honest-baseline",          A, B),
      ...tournamentRoundConfigs(ctx, specsUp,    "stealth-withholder-up",    A, B),
      ...tournamentRoundConfigs(ctx, specsDown,  "stealth-withholder-down",  A, B),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /**
   * Tournament Round 4. The `convergent-cabal` attacker against System A
   * (nudge baseline) and System B-hardened-v2 (median + wideband + freeze-aware).
   *
   * Round 3's stealth-withholder broke B-hardened-v1 by aligning lock-step
   * abstention with freeze branches that skipped the confidence callback.
   * Defense #2 closed that seam; on hardened-v2, stealth-withholder's
   * cabal hits zero confidence in ~100 freeze blocks and is permanently
   * excluded.
   *
   * Round 4 introduces a structurally new mechanism: **stateful trend
   * detection + reward arbitrage**. Cabal members maintain identical
   * rolling buffers of recent observations (zero-jitter lock-step) and
   * abstain ONLY when (a) the local observation pushes oracle in the
   * bias direction AND (b) real has moved >= `trendMagnitude` over the
   * trend window. On all other blocks they submit honest in-band quotes
   * and earn +REWARD_DELTA. The intuition: if the cabal can spend
   * abstention budget on rare-but-impactful blocks while accumulating
   * reward budget on common-but-low-impact blocks, they may stay active
   * indefinitely AND occasionally freeze the oracle during damaging trends.
   *
   * The attack is also nudge-amplified: pool-poison every block, and on
   * cabal-authored blocks during a trend window activate ALL in-direction
   * bumps in the pool (carrying forward overshoot-ratchet's author logic
   * with a trend gate).
   *
   * Predicted outcomes:
   *   - System A (nudge baseline): bounded. Asymmetric author injection
   *     hits the same ~1% ceiling we've established in rounds 1-3.
   *   - System B (hardened-v2): bounded. Reward/penalty are both 0.01
   *     per block; if abstain rate is moderate (< ~50% of blocks), cabal
   *     stays active, but each freeze block is a single-block freeze and
   *     the oracle catches up on the next non-trend block. Long sustained
   *     trends in DOT data are real but rare and bounded; expected mean
   *     deviation comparable to round-3 hardened-B (0.2-0.4%).
   *
   * If both systems remain bounded, this is decisive evidence we are at
   * the hardening floor of the current defense stack against the lock-step-
   * + selective-abstention attack class.
   *
   * See TOURNAMENT.md.
   */
  async "tournament-round-4"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: tournament-round-4 — convergent-cabal vs A baseline & B-hardened-v2]`);
    const f = 1 / 3;
    // Lock-step observation: every cabal member sees the identical real
    // price each block, so each member's rolling trend buffer is byte-
    // identical, and the abstain predicate fires across all 100 in
    // perfect coordination. (Same trick as round-3 stealth-withholder.)
    const cabalPS: ValidatorPriceSource = { kind: "cross-venue", jitterStdDev: 0 };
    const specsUp: GroupSpec[] = [{
      type: "convergent-cabal",
      fraction: f,
      priceSource: cabalPS,
      params: {
        convergentCabalDirection: "up",
        convergentCabalTrendBlocks: 30,
        convergentCabalTrendMagnitude: 0.0030,
        convergentCabalCeilingBumps: 200,
      },
    }];
    const specsDown: GroupSpec[] = [{
      type: "convergent-cabal",
      fraction: f,
      priceSource: cabalPS,
      params: {
        convergentCabalDirection: "down",
        convergentCabalTrendBlocks: 30,
        convergentCabalTrendMagnitude: 0.0030,
        convergentCabalCeilingBumps: 200,
      },
    }];
    const A = TOURNAMENT_SYSTEM_A_CURRENT(ctx);
    const B = TOURNAMENT_SYSTEM_B_CURRENT;
    const configs: SimulationConfig[] = [
      ...tournamentRoundConfigs(ctx, [],         "honest-baseline",         A, B),
      ...tournamentRoundConfigs(ctx, specsUp,    "convergent-cabal-up",     A, B),
      ...tournamentRoundConfigs(ctx, specsDown,  "convergent-cabal-down",   A, B),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  /**
   * tournament-round-5 — InBandShifter vs A baseline & B-hardened-v3.
   *
   * First of two stopping-rule rounds: B has 3 committed defenses, A has 0,
   * and a "decisive win" requires A to survive two more rounds without
   * breaking. Round 5's attacker is designed to probe the remaining attack
   * surface honestly:
   *   - Quote leg: in-band biased quotes at 4% bias (strictly inside the
   *     5% wideband). Cabal never abstains, never sends bad quotes →
   *     attribution-immune. Tests whether a median can still be shifted by
   *     a 1/3 cabal that is invisible to all three committed B defenses.
   *   - Nudge leg: pool-poison + always-inject author (no ceiling freeze).
   *     Slightly more aggressive than overshoot-ratchet for A.
   *
   * Default jitter (0.1%) for the cabal — no zero-jitter trick is needed
   * since this attacker doesn't depend on lock-step abstention. Both
   * directions tested.
   */
  async "tournament-round-5"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: tournament-round-5 — inband-shifter vs A baseline & B-hardened-v3]`);
    const f = 1 / 3;
    const specsUp: GroupSpec[] = [{
      type: "inband-shifter",
      fraction: f,
      params: {
        inbandShifterDirection: "up",
        inbandShifterQuoteBias: 0.04,
        inbandShifterCeilingBumps: 200,
      },
    }];
    const specsDown: GroupSpec[] = [{
      type: "inband-shifter",
      fraction: f,
      params: {
        inbandShifterDirection: "down",
        inbandShifterQuoteBias: 0.04,
        inbandShifterCeilingBumps: 200,
      },
    }];
    const A = TOURNAMENT_SYSTEM_A_CURRENT(ctx);
    const B = TOURNAMENT_SYSTEM_B_CURRENT;
    const configs: SimulationConfig[] = [
      ...tournamentRoundConfigs(ctx, [],         "honest-baseline",      A, B),
      ...tournamentRoundConfigs(ctx, specsUp,    "inband-shifter-up",    A, B),
      ...tournamentRoundConfigs(ctx, specsDown,  "inband-shifter-down",  A, B),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

  async "tournament-defense-1-confidence"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: tournament-defense-1-confidence — re-test rounds 0 & 1 attackers vs hardened B]`);
    const f = 1 / 3;
    const A = TOURNAMENT_SYSTEM_A_BASELINE(ctx);
    const B_HARDENED_v1: AggregatorConfig = {
      kind: "median",
      confidence: "default",
      permanentExclusion: true,
    };
    const wUp:   GroupSpec[] = [{ type: "withholder",    fraction: f, params: { withholderDirection: "up" } }];
    const wDn:   GroupSpec[] = [{ type: "withholder",    fraction: f, params: { withholderDirection: "down" } }];
    const biUp:  GroupSpec[] = [{ type: "bias-injector", fraction: f, params: { biasInjectorDirection: "up" } }];
    const biDn:  GroupSpec[] = [{ type: "bias-injector", fraction: f, params: { biasInjectorDirection: "down" } }];
    const configs: SimulationConfig[] = [
      ...tournamentRoundConfigs(ctx, [],    "honest-baseline",        A, B_HARDENED_v1),
      ...tournamentRoundConfigs(ctx, wUp,   "withholder-up",          A, B_HARDENED_v1),
      ...tournamentRoundConfigs(ctx, wDn,   "withholder-down",        A, B_HARDENED_v1),
      ...tournamentRoundConfigs(ctx, biUp,  "bias-injector-up",       A, B_HARDENED_v1),
      ...tournamentRoundConfigs(ctx, biDn,  "bias-injector-down",     A, B_HARDENED_v1),
    ];
    return runBatch(configs, priceSource, outputDir, threadCount);
  },
};

export function listScenarios(): string[] {
  return Object.keys(scenarios);
}

// Re-export for callers (main.ts) that need to spell the default ctx.
export { DEFAULT_CONFIG, DEFAULT_PRICE_SOURCE, DEFAULT_VALIDATOR_COUNT };

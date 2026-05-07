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
import { buildValidators, formatValidators, NON_CONFIDENCE_ATTACKERS, type GroupSpec } from "../validators.js";

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
  if (cfg.kind === "median" && cfg.k && cfg.k > 0) parts.push(`k=${cfg.k}`);
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
  /**
   * Core-attackers research sweep — the post-confidence-tracking baseline.
   *
   * Compares the **nudge** aggregator (across three ε values: auto, auto/2,
   * auto/4) and the **median** aggregator (no confidence tracking) against
   * the non-confidence-targeting attackers from NON_CONFIDENCE_ATTACKERS:
   * malicious, pushy, noop, delayed, drift.
   *
   * Adversary fractions: 33% (main focus, "byzantine border") and 10% (smaller
   * data-point). For each (aggregator, attacker, fraction) we run one sim,
   * plus an honest baseline for every aggregator config.
   *
   *   Sims = 4 baselines + |attackers|·|fractions|·(3 nudge ε + 1 median)
   *        = 4 + 5·2·4 = 44
   *
   * Confidence-targeting cabal types (withholder, bias-injector, etc.) are
   * deliberately excluded — see VALIDATOR_METADATA in src/validators.ts.
   */
  async "core-attackers"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: core-attackers]`);
    const fractions = [0.10, 0.33];
    const autoEps = 1 / ctx.validatorCount / 10;
    const epsilons: Array<{ label: string; value: number }> = [
      { label: "auto",    value: autoEps },
      { label: "auto/2",  value: autoEps / 2 },
      { label: "auto/4",  value: autoEps / 4 },
    ];
    const medianAgg: AggregatorConfig = { kind: "median" };
    const aggLabel = (a: AggregatorConfig, epsLabel?: string) =>
      a.kind === "nudge" ? `nudge ε=${epsLabel}` : a.kind;

    const configs: SimulationConfig[] = [];

    // Honest baselines — one per aggregator config so each malicious row has
    // a same-aggregator reference to compare against.
    for (const e of epsilons) {
      configs.push(makeConfig(ctx, [], `${aggLabel({ kind: "nudge", epsilon: e.value }, e.label)} · honest`,
        { kind: "nudge", epsilon: e.value }));
    }
    configs.push(makeConfig(ctx, [], `${aggLabel(medianAgg)} · honest`, medianAgg));

    // Attacker × fraction × aggregator grid.
    for (const type of NON_CONFIDENCE_ATTACKERS) {
      for (const frac of fractions) {
        const fracPct = (frac * 100).toFixed(0);
        const specs: GroupSpec[] = [{ type, fraction: frac }];
        for (const e of epsilons) {
          configs.push(makeConfig(ctx, specs,
            `${aggLabel({ kind: "nudge", epsilon: e.value }, e.label)} · ${type}@${fracPct}%`,
            { kind: "nudge", epsilon: e.value }));
        }
        configs.push(makeConfig(ctx, specs,
          `${aggLabel(medianAgg)} · ${type}@${fracPct}%`, medianAgg));
      }
    }

    console.log(`  ${configs.length} simulations: ${epsilons.length} nudge ε's + 1 median × `
      + `(1 honest + ${NON_CONFIDENCE_ATTACKERS.length} attackers × ${fractions.length} fractions)`);
    return runBatch(configs, priceSource, outputDir, threadCount);
  },

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
      { kind: "median", k: 0.1 },
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
   * Strict-threshold rerun (byzantine = 99/300).
   *
   * Compares median (no confidence tracking; that path was found harmful) to
   * three nudge variants at decreasing epsilon:
   *
   *   [A ε:1]  nudge with epsilon = auto = maxBlockDelta / N
   *   [A ε:½]  nudge with epsilon = auto / 2
   *   [A ε:¼]  nudge with epsilon = auto / 4
   *   [B med]  median + minInputs = floor(2N/3)+1
   *
   * Smaller epsilon = slower reaction to fast real-price moves but lower
   * per-block noise floor and less per-block leverage for attackers — a
   * potential nudge "hardening" without adding any per-validator state.
   *
   * Direction-suffixed labels use ↑ / ↓ for compactness.
   */
  async "tournament-rerun-strict-threshold"(ctx, priceSource, outputDir, threadCount) {
    console.log(`\n[Scenario: tournament-rerun-strict-threshold — nudge ε sweep + median, byzantine = 99/300]`);
    const f = 99 / 300;

    // Pre-resolve the auto epsilon so we can scale it.
    const autoEps = maxBlockDelta(priceSource.pricePoints) / Math.max(1, ctx.validatorCount);
    const A_full: AggregatorConfig = { kind: "nudge", epsilon: autoEps };
    const A_half: AggregatorConfig = { kind: "nudge", epsilon: autoEps / 2 };
    const A_qtr:  AggregatorConfig = { kind: "nudge", epsilon: autoEps / 4 };
    const B_med = TOURNAMENT_SYSTEM_B_BASELINE;

    // Attackers split by directionality:
    //   directional → emits ↑ and ↓ variants
    //   directionless → single variant (intrinsic direction or stateless)
    const directional: Array<{ short: string; up: GroupSpec; dn: GroupSpec }> = [
      { short: "withholder",     up: { type: "withholder",         fraction: f, params: { withholderDirection:        "up"   } },
                                 dn: { type: "withholder",         fraction: f, params: { withholderDirection:        "down" } } },
      { short: "bias-injector",  up: { type: "bias-injector",      fraction: f, params: { biasInjectorDirection:      "up"   } },
                                 dn: { type: "bias-injector",      fraction: f, params: { biasInjectorDirection:      "down" } } },
      { short: "overshoot",      up: { type: "overshoot-ratchet",  fraction: f, params: { overshootRatchetDirection:  "up"   } },
                                 dn: { type: "overshoot-ratchet",  fraction: f, params: { overshootRatchetDirection:  "down" } } },
      { short: "stealth-with",   up: { type: "stealth-withholder", fraction: f, params: { stealthWithholderDirection: "up"   } },
                                 dn: { type: "stealth-withholder", fraction: f, params: { stealthWithholderDirection: "down" } } },
      { short: "convergent",     up: { type: "convergent-cabal",   fraction: f, params: { convergentCabalDirection:   "up"   } },
                                 dn: { type: "convergent-cabal",   fraction: f, params: { convergentCabalDirection:   "down" } } },
      { short: "inband-shifter", up: { type: "inband-shifter",     fraction: f, params: { inbandShifterDirection:     "up"   } },
                                 dn: { type: "inband-shifter",     fraction: f, params: { inbandShifterDirection:     "down" } } },
    ];

    const directionless: Array<{ short: string; spec: GroupSpec }> = [
      { short: "malicious", spec: { type: "malicious", fraction: f } },
      { short: "pushy",     spec: { type: "pushy",     fraction: f } },
      { short: "noop",      spec: { type: "noop",      fraction: f } },
      { short: "delayed",   spec: { type: "delayed",   fraction: f } },
      { short: "drift",     spec: { type: "drift",     fraction: f } },
    ];

    const systems: Array<{ tag: string; agg: AggregatorConfig }> = [
      { tag: "A ε:1", agg: A_full },
      { tag: "A ε:½", agg: A_half },
      { tag: "A ε:¼", agg: A_qtr  },
      { tag: "B med", agg: B_med  },
    ];

    /** Cross product (every system × this attacker variant). */
    const sweep = (specs: GroupSpec[], attackerLabel: string): SimulationConfig[] =>
      systems.map(s => makeConfig(ctx, specs, `[${s.tag}] ${attackerLabel}`, s.agg));

    const configs: SimulationConfig[] = [
      ...sweep([], "honest"),
      ...directional.flatMap(a => [
        ...sweep([a.up], `${a.short}↑`),
        ...sweep([a.dn], `${a.short}↓`),
      ]),
      ...directionless.flatMap(a => sweep([a.spec], a.short)),
    ];

    const variantCount = 1 + 2 * directional.length + directionless.length;
    console.log(
      `  Auto-ε resolved: ${autoEps.toFixed(6)}  (½ = ${(autoEps/2).toFixed(6)}, ¼ = ${(autoEps/4).toFixed(6)})`,
    );
    console.log(`  Total sims: ${configs.length} (${variantCount} variants × ${systems.length} systems)`);
    return runBatch(configs, priceSource, outputDir, threadCount);
  },
};

export function listScenarios(): string[] {
  return Object.keys(scenarios);
}

// Re-export for callers (main.ts) that need to spell the default ctx.
export { DEFAULT_CONFIG, DEFAULT_PRICE_SOURCE, DEFAULT_VALIDATOR_COUNT };

import { join } from "path";
import { mkdirSync } from "fs";
import type { SimulationConfig, SimulationResult, PricePoint, ScenarioMeta, ValidatorMix } from "../types.js";
import { DEFAULT_CONFIG } from "../config.js";
import { runSimulation, type BlockSink } from "../sim/engine.js";
import { maxBlockDelta } from "../data/interpolator.js";
import { ChunkWriter, writeIndex } from "../viz/writer.js";
import { loadCriteria } from "./research-criteria.js";
import { generateReport } from "./research-report.js";
import { formatMix } from "../mix.js";

export type ScenarioFn = (
  baseConfig: Partial<SimulationConfig>,
  pricePoints: PricePoint[],
  outputDir?: string,
  threadCount?: number,
) => Promise<SimulationResult[]>;

function mergeConfig(overrides: Partial<SimulationConfig>): SimulationConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Run a single simulation, optionally writing block data to a scenario subdirectory.
 * Returns the SimulationResult (config + summary, no metrics in memory).
 */
function runOne(
  config: SimulationConfig,
  pricePoints: PricePoint[],
  outputDir: string | undefined,
  scenarioIndex: number,
): { result: SimulationResult; meta?: ScenarioMeta } {
  let sink: BlockSink | undefined;
  let writer: ChunkWriter | undefined;

  if (outputDir) {
    const scenarioDir = join(outputDir, `scenario_${scenarioIndex}`);
    writer = new ChunkWriter(scenarioDir);
    sink = writer.sink;
  }

  const result = runSimulation(config, pricePoints, sink);

  let meta: ScenarioMeta | undefined;
  if (writer) {
    const info = writer.finish();
    meta = {
      config: result.config,
      summary: result.summary,
      blockCount: info.blockCount,
      chunkCount: info.chunkCount,
      timeRange: info.timeRange,
    };
  }

  return { result, meta };
}

/**
 * Run multiple configs as a scenario batch.
 * Uses a Bun Worker pool when threadCount > 1 and there are multiple configs.
 */
async function runBatch(
  configs: SimulationConfig[],
  pricePoints: PricePoint[],
  outputDir?: string,
  threadCount = 1,
): Promise<SimulationResult[]> {
  if (outputDir) mkdirSync(outputDir, { recursive: true });

  let results: SimulationResult[];
  let metas: (ScenarioMeta | undefined)[];

  if (threadCount > 1 && configs.length > 1) {
    ({ results, metas } = await runBatchParallel(configs, pricePoints, threadCount, outputDir));
  } else {
    results = [];
    metas = [];
    for (let i = 0; i < configs.length; i++) {
      const { result, meta } = runOne(configs[i], pricePoints, outputDir, i);
      results.push(result);
      metas.push(meta);
    }
  }

  if (outputDir) {
    const validMetas = metas.filter((m): m is ScenarioMeta => m !== undefined);
    if (validMetas.length > 0) writeIndex(outputDir, validMetas);
  }

  return results;
}

/**
 * Distribute simulations across Bun Workers using a work-stealing pool.
 * Each worker gets its own copy of pricePoints on init, then runs simulations
 * sequentially. Workers write chunk files directly to their scenario directories.
 * Renders a live multi-line ANSI progress display.
 */
async function runBatchParallel(
  configs: SimulationConfig[],
  pricePoints: PricePoint[],
  threadCount: number,
  outputDir?: string,
): Promise<{ results: SimulationResult[]; metas: (ScenarioMeta | undefined)[] }> {
  const workerCount = Math.min(threadCount, configs.length);
  console.log(`  Spawning ${workerCount} workers for ${configs.length} simulations...\n`);

  const workerURL = new URL("../sim/worker.ts", import.meta.url);
  const workers: Worker[] = [];

  // Initialize workers: each receives a copy of pricePoints
  await Promise.all(
    Array.from({ length: workerCount }, () =>
      new Promise<void>((resolve, reject) => {
        const w = new Worker(workerURL);
        workers.push(w);
        w.onmessage = (e) => { if (e.data.type === "ready") resolve(); };
        w.onerror = (e) => reject(e);
        w.postMessage({ type: "init", pricePoints });
      })
    )
  );

  // Per-worker display state
  const workerState: { label: string; pct: number }[] = Array.from(
    { length: workerCount },
    () => ({ label: "idle", pct: 0 }),
  );
  const workerIndexMap = new Map<Worker, number>();
  workers.forEach((w, i) => workerIndexMap.set(w, i));

  // ANSI multi-line progress renderer
  let linesPrinted = 0;
  let lastRedraw = 0;
  const REDRAW_MS = 150;

  function redraw(force = false) {
    const now = Date.now();
    if (!force && now - lastRedraw < REDRAW_MS) return;
    lastRedraw = now;

    // Move cursor up to overwrite previous output
    if (linesPrinted > 0) process.stdout.write(`\x1B[${linesPrinted}A`);

    let lines = 0;
    for (let i = 0; i < workerCount; i++) {
      const ws = workerState[i];
      const bar = progressBar(ws.pct, 20);
      process.stdout.write(`\x1B[2K  Worker ${String(i + 1).padStart(2)}: ${bar} ${ws.label}\n`);
      lines++;
    }
    const overallPct = ((completed / configs.length) * 100).toFixed(0);
    const overallBar = progressBar((completed / configs.length) * 100, 20);
    process.stdout.write(`\x1B[2K  Overall: ${overallBar} ${completed}/${configs.length} simulations\n`);
    lines++;
    linesPrinted = lines;
  }

  // Work-stealing: assign tasks as workers become free
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

  // Final newline after progress display
  console.log();

  for (const w of workers) w.terminate();
  return { results, metas };
}

function progressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]" + ` ${pct.toFixed(0).padStart(3)}%`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}

export const scenarios: Record<string, ScenarioFn> = {
  /** Baseline: 100% honest */
  async honest(overrides, pricePoints, outputDir, threadCount) {
    console.log(`\n[Scenario: honest]`);
    const config = mergeConfig({ ...overrides, validatorMix: {}, label: "honest (100%)" });
    return runBatch([config], pricePoints, outputDir, threadCount);
  },

  /** Sweep malicious fraction from 0% to 50% */
  async "sweep-malicious"(overrides, pricePoints, outputDir, threadCount) {
    const fractions = [0, 0.1, 0.2, 0.3, 0.4, 0.49, 0.5];
    const configs = fractions.map((frac) => {
      const label = `${(frac * 100).toFixed(0)}% malicious`;
      return mergeConfig({ ...overrides, validatorMix: { malicious: frac }, label });
    });
    return runBatch(configs, pricePoints, outputDir, threadCount);
  },

  /** Sweep all malicious variants with a fixed epsilon */
  async "sweep-all-malicious"(overrides, pricePoints, outputDir, threadCount) {
    const mixes: ValidatorMix[] = [
      {},                   // 0% (baseline)
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
    const configs: SimulationConfig[] = [];

    for (const mix of mixes) {
      const label = formatMix(mix);
      configs.push(mergeConfig({ ...overrides, validatorMix: mix, label }));
    }

    return runBatch(configs, pricePoints, outputDir, threadCount);
  },

  async "sweep-malicious-and-epsilon"(overrides, pricePoints, outputDir, threadCount) {
    const fractions = [0, 0.1, 0.2, 0.3];
    const epsilons = [(DEFAULT_CONFIG.epsilon as number) / 5, DEFAULT_CONFIG.epsilon, (DEFAULT_CONFIG.epsilon as number) * 5];
    const configs: SimulationConfig[] = [];

    for (const frac of fractions) {
      for (const epsilon of epsilons) {
        const label = `${(frac * 100).toFixed(0)}% malicious, epsilon=${(epsilon as number).toFixed(6)}`;
        configs.push(mergeConfig({ ...overrides, validatorMix: { malicious: frac }, epsilon, label }));
      }
    }
    return runBatch(configs, pricePoints, outputDir, threadCount);
  },

  async "sweep-pushy-and-epsilon"(overrides, pricePoints, outputDir, threadCount) {
    const fractions = [0, 0.1, 0.2, 0.3];
    const epsilons = [(DEFAULT_CONFIG.epsilon as number) / 5, DEFAULT_CONFIG.epsilon, (DEFAULT_CONFIG.epsilon as number) * 5];
    const configs: SimulationConfig[] = [];

    for (const frac of fractions) {
      for (const epsilon of epsilons) {
        const label = `${(frac * 100).toFixed(0)}% pushy, epsilon=${(epsilon as number).toFixed(6)}`;
        configs.push(mergeConfig({ ...overrides, validatorMix: { pushy: frac }, epsilon, label }));
      }
    }
    return runBatch(configs, pricePoints, outputDir, threadCount);
  },

  /** Vary epsilon to find optimal value */
  async "epsilon-sweep"(overrides, pricePoints, outputDir, threadCount) {
    const multipliers = [0.25, 0.5, 1, 2, 4];
    const autoConfig = mergeConfig(overrides);
    const maxDelta = maxBlockDelta(pricePoints);
    const baseEpsilon = maxDelta / autoConfig.validatorCount;

    const configs = multipliers.map((mult) => {
      const eps = baseEpsilon * mult;
      const label = `epsilon=${eps.toFixed(6)} (${mult}x)`;
      return mergeConfig({ ...overrides, epsilon: eps, label });
    });
    return runBatch(configs, pricePoints, outputDir, threadCount);
  },

  /** Stress test: 49% malicious */
  async stress(overrides, pricePoints, outputDir, threadCount) {
    console.log(`\n[Scenario: stress]`);
    const config = mergeConfig({
      ...overrides,
      validatorMix: { malicious: 0.49 },
      label: "stress (49% malicious)",
    });
    return runBatch([config], pricePoints, outputDir, threadCount);
  },

  /** For all malicious variants, show 49% and 50% */
  async "edge-malicious"(overrides, pricePoints, outputDir, threadCount) {
    const mixes: ValidatorMix[] = [
      { malicious: 0.49 },
      { malicious: 0.50 },
      { pushy: 0.49 },
      { pushy: 0.50 },
      { noop: 0.49 },
      { noop: 0.50 },
      { delayed: 0.49 },
      { delayed: 0.50 },
      { drift: 0.49 },
      { drift: 0.50 },
    ];
    const configs: SimulationConfig[] = [];
    for (const mix of mixes) {
      configs.push(mergeConfig({ ...overrides, validatorMix: mix, label: formatMix(mix) }));
  }
    return runBatch(configs, pricePoints, outputDir, threadCount);
  },

  /**
   * Research: grid search over epsilon multipliers × adversary mixes.
   * Scores each combination and produces a report recommending the optimal epsilon.
   */
  async research(overrides, pricePoints, outputDir, threadCount) {
    console.log(`\n[Scenario: research]`);
    const criteria = loadCriteria();
    const base = mergeConfig({ ...overrides, convergenceThreshold: criteria.convergenceThreshold });

    // Compute auto epsilon
    const maxDelta = maxBlockDelta(pricePoints);
    const autoEpsilon = maxDelta / base.validatorCount || 0.0001;
    console.log(`  Auto-epsilon base: ${autoEpsilon.toFixed(6)}`);

    // Grid dimensions
    const multipliers = [0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];
    const mixes: ValidatorMix[] = [
      {},                   // 0% (baseline)
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

    // Build epsilon -> multiplier lookup
    const epsilonMultipliers = new Map<number, number>();
    for (const mult of multipliers) {
      epsilonMultipliers.set(autoEpsilon * mult, mult);
    }

    // Build all configs
    const configs: SimulationConfig[] = [];
    for (const mult of multipliers) {
      const eps = autoEpsilon * mult;
      for (const mix of mixes) {
        const mixDesc = formatMix(mix);
        const label = `eps=${eps.toFixed(6)} (${mult}x), ${mixDesc}`;
        configs.push(mergeConfig({
          ...overrides,
          epsilon: eps,
          validatorMix: mix,
          convergenceThreshold: criteria.convergenceThreshold,
          label,
        }));
      }
    }

    console.log(`  Grid: ${multipliers.length} epsilons x ${mixes.length} mixes = ${configs.length} simulations`);

    const results = await runBatch(configs, pricePoints, outputDir, threadCount);

    // Generate report
    const reportPath = outputDir
      ? join(outputDir, "research_report.json")
      : "research_report.json";
    generateReport(results, epsilonMultipliers, criteria, autoEpsilon, reportPath);

    return results;
  },
};

export function listScenarios(): string[] {
  return Object.keys(scenarios);
}

import { join } from "path";
import { mkdirSync } from "fs";
import type { SimulationConfig, SimulationResult, PricePoint, ScenarioMeta } from "../types.js";
import { DEFAULT_CONFIG } from "../config.js";
import { runSimulation, type BlockSink } from "../sim/engine.js";
import { maxBlockDelta } from "../data/interpolator.js";
import { ChunkWriter, writeIndex } from "../viz/writer.js";

type ScenarioFn = (
  baseConfig: Partial<SimulationConfig>,
  pricePoints: PricePoint[],
  outputDir?: string,
) => SimulationResult[];

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
 * Run multiple configs as a scenario batch, writing chunked output if outputDir is provided.
 */
function runBatch(
  configs: SimulationConfig[],
  pricePoints: PricePoint[],
  outputDir?: string,
): SimulationResult[] {
  if (outputDir) mkdirSync(outputDir, { recursive: true });

  const results: SimulationResult[] = [];
  const metas: ScenarioMeta[] = [];

  for (let i = 0; i < configs.length; i++) {
    const { result, meta } = runOne(configs[i], pricePoints, outputDir, i);
    results.push(result);
    if (meta) metas.push(meta);
  }

  if (outputDir && metas.length > 0) {
    writeIndex(outputDir, metas);
  }

  return results;
}

export const scenarios: Record<string, ScenarioFn> = {
  /** Baseline: 100% honest */
  honest(overrides, pricePoints, outputDir) {
    console.log(`\n[Scenario: honest]`);
    const config = mergeConfig({ ...overrides, validatorMix: {}, label: "honest (100%)" });
    return runBatch([config], pricePoints, outputDir);
  },

  /** Sweep malicious fraction from 0% to 50% */
  "sweep-malicious"(overrides, pricePoints, outputDir) {
    const fractions = [0, 0.1, 0.2, 0.3, 0.4, 0.49, 0.5];
    const configs = fractions.map((frac) => {
      const label = `${(frac * 100).toFixed(0)}% malicious`;
      console.log(`\n[Scenario: sweep-malicious — ${label}]`);
      return mergeConfig({ ...overrides, validatorMix: { malicious: frac }, label });
    });
    return runBatch(configs, pricePoints, outputDir);
  },

  "sweep-malicious-and-epsilon"(overrides, pricePoints, outputDir) {
    const fractions = [0, 0.1, 0.2, 0.3];
    const epsilons = [(DEFAULT_CONFIG.epsilon as number) / 5, DEFAULT_CONFIG.epsilon, (DEFAULT_CONFIG.epsilon as number) * 5];
    const configs: SimulationConfig[] = [];

    for (const frac of fractions) {
      for (const epsilon of epsilons) {
        const label = `${(frac * 100).toFixed(0)}% malicious, epsilon=${(epsilon as number).toFixed(6)}`;
        console.log(`\n[Scenario: sweep-malicious-and-epsilon — ${label}]`);
        configs.push(mergeConfig({ ...overrides, validatorMix: { malicious: frac }, epsilon, label }));
      }
    }
    return runBatch(configs, pricePoints, outputDir);
  },

  "sweep-pushy-and-epsilon"(overrides, pricePoints, outputDir) {
    const fractions = [0, 0.1, 0.2, 0.3];
    const epsilons = [(DEFAULT_CONFIG.epsilon as number) / 5, DEFAULT_CONFIG.epsilon, (DEFAULT_CONFIG.epsilon as number) * 5];
    const configs: SimulationConfig[] = [];

    for (const frac of fractions) {
      for (const epsilon of epsilons) {
        const label = `${(frac * 100).toFixed(0)}% pushy, epsilon=${(epsilon as number).toFixed(6)}`;
        console.log(`\n[Scenario: sweep-pushy-and-epsilon — ${label}]`);
        configs.push(mergeConfig({ ...overrides, validatorMix: { pushy: frac }, epsilon, label }));
      }
    }
    return runBatch(configs, pricePoints, outputDir);
  },

  /** Vary epsilon to find optimal value */
  "epsilon-sweep"(overrides, pricePoints, outputDir) {
    const multipliers = [0.25, 0.5, 1, 2, 4];
    const autoConfig = mergeConfig(overrides);
    const maxDelta = maxBlockDelta(pricePoints);
    const baseEpsilon = maxDelta / autoConfig.validatorCount;

    const configs = multipliers.map((mult) => {
      const eps = baseEpsilon * mult;
      const label = `epsilon=${eps.toFixed(6)} (${mult}x)`;
      console.log(`\n[Scenario: epsilon-sweep — ${label}]`);
      return mergeConfig({ ...overrides, epsilon: eps, label });
    });
    return runBatch(configs, pricePoints, outputDir);
  },

  /** Stress test: 49% malicious */
  stress(overrides, pricePoints, outputDir) {
    console.log(`\n[Scenario: stress]`);
    const config = mergeConfig({
      ...overrides,
      validatorMix: { malicious: 0.49 },
      label: "stress (49% malicious)",
    });
    return runBatch([config], pricePoints, outputDir);
  },
};

export function listScenarios(): string[] {
  return Object.keys(scenarios);
}

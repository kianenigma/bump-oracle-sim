import type { SimulationConfig, SimulationResult, PricePoint } from "../types.js";
import { DEFAULT_CONFIG } from "../config.js";
import { runSimulation } from "../sim/engine.js";
import { maxBlockDelta } from "../data/interpolator.js";

type ScenarioFn = (baseConfig: Partial<SimulationConfig>, pricePoints: PricePoint[]) => SimulationResult[];

function mergeConfig(overrides: Partial<SimulationConfig>): SimulationConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

export const scenarios: Record<string, ScenarioFn> = {
  /** Baseline: 100% honest */
  honest(overrides, pricePoints) {
    const config = mergeConfig({ ...overrides, validatorMix: {}, label: "honest (100%)" });
    console.log(`\n[Scenario: honest]`);
    return [runSimulation(config, pricePoints)];
  },

  /** Sweep malicious fraction from 0% to 50% */
  "sweep-malicious"(overrides, pricePoints) {
    const fractions = [0, 0.1, 0.2, 0.3, 0.4, 0.49, 0.5];
    const results: SimulationResult[] = [];

    for (const frac of fractions) {
      const label = `${(frac * 100).toFixed(0)}% malicious`;
      console.log(`\n[Scenario: sweep-malicious — ${label}]`);
      const config = mergeConfig({ ...overrides, validatorMix: { malicious: frac }, label });
      results.push(runSimulation(config, pricePoints));
    }

    return results;
  },

  "sweep-malicious-and-epsilon"(overrides, pricePoints) {
    const fractions = [0, 0.1, 0.2, 0.3];
    const epsilons = [(DEFAULT_CONFIG.epsilon as number) / 5, DEFAULT_CONFIG.epsilon, (DEFAULT_CONFIG.epsilon as number) * 5];
    const results: SimulationResult[] = [];

    for (const frac of fractions) {
      for (const epsilon of epsilons) {
        const label = `${(frac * 100).toFixed(0)}% malicious, epsilon=${(epsilon as number).toFixed(6)}`;
        console.log(`\n[Scenario: sweep-malicious-and-epsilon — ${label}]`);
        const config = mergeConfig({ ...overrides, validatorMix: { malicious: frac }, epsilon, label });
        results.push(runSimulation(config, pricePoints));
      }
    }

    return results;
  },

  "sweep-pushy-and-epsilon"(overrides, pricePoints) {
    const fractions = [0, 0.1, 0.2, 0.3];
    const epsilons = [(DEFAULT_CONFIG.epsilon as number) / 5, DEFAULT_CONFIG.epsilon, (DEFAULT_CONFIG.epsilon as number) * 5];
    const results: SimulationResult[] = [];

    for (const frac of fractions) {
      for (const epsilon of epsilons) {
        const label = `${(frac * 100).toFixed(0)}% pushy, epsilon=${(epsilon as number).toFixed(6)}`;
        console.log(`\n[Scenario: sweep-pushy-and-epsilon — ${label}]`);
        const config = mergeConfig({ ...overrides, validatorMix: { pushy: frac }, epsilon, label });
        results.push(runSimulation(config, pricePoints));
      }
    }

    return results;
  },

  /** Vary epsilon to find optimal value */
  "epsilon-sweep"(overrides, pricePoints) {
    const multipliers = [0.25, 0.5, 1, 2, 4];
    const results: SimulationResult[] = [];

    const autoConfig = mergeConfig(overrides);
    const maxDelta = maxBlockDelta(pricePoints);
    const baseEpsilon = maxDelta / (autoConfig.validatorCount || 100);

    for (const mult of multipliers) {
      const eps = baseEpsilon * mult;
      const label = `epsilon=${eps.toFixed(6)} (${mult}x)`;
      console.log(`\n[Scenario: epsilon-sweep — ${label}]`);
      const config = mergeConfig({ ...overrides, epsilon: eps, label });
      results.push(runSimulation(config, pricePoints));
    }

    return results;
  },

  /** Stress test: 49% malicious */
  stress(overrides, pricePoints) {
    const config = mergeConfig({
      ...overrides,
      validatorMix: { malicious: 0.49 },
      label: "stress (49% malicious)",
    });
    console.log(`\n[Scenario: stress]`);
    return [runSimulation(config, pricePoints)];
  },
};

export function listScenarios(): string[] {
  return Object.keys(scenarios);
}

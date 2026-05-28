/**
 * Tiny harness for running deterministic per-block aggregator simulations
 * without going through the data-loader pipeline. Each test:
 *
 *   1. Supplies a fake `prices` array — one entry per block, in chronological
 *      order. With `jitterStdDev: 0` every validator reads this value exactly.
 *   2. Supplies a `validators` mix + an `AggregatorConfig`.
 *   3. Receives the full `BlockMetrics[]` for the run; `printBlocks` formats
 *      one row per block so test output is human-inspectable.
 *
 * The harness wraps the existing `runSimulation` engine — we don't fork any
 * code paths. That keeps test behaviour identical to production sims.
 */
import { runSimulation } from "../src/sim/engine.js";
import type {
  AggregatorConfig,
  BlockMetrics,
  PricePoint,
  ResolvedPriceSource,
  SimulationConfig,
  ValidatorGroup,
} from "../src/types.js";

export interface TestScenario {
  /** Fake real-price path: one entry per block, in order. */
  prices: number[];
  /** Validator mix. Each group's `count` summed = total validators. */
  validators: ValidatorGroup[];
  /** Aggregator under test. */
  aggregator: AggregatorConfig;
  /** PRNG seed. Default 42 — change to vary author selection. */
  seed?: number;
}

const FIRST_TS = 1_700_000_000;
const BLOCK_TIME_SECONDS = 6;

/** Build a `ResolvedPriceSource` from a per-block price array. Timestamps
 *  start at `FIRST_TS` and step by `BLOCK_TIME_SECONDS`. */
export function makePricePath(prices: number[]): ResolvedPriceSource {
  const pricePoints: PricePoint[] = prices.map((price, i) => ({
    timestamp: FIRST_TS + i * BLOCK_TIME_SECONDS,
    price,
  }));
  return { pricePoints };
}

/** Run a scenario end-to-end. Returns one `BlockMetrics` per block. */
export function runScenario(scenario: TestScenario): BlockMetrics[] {
  const source = makePricePath(scenario.prices);
  const config: SimulationConfig = {
    startDate: "2023-11-14",
    endDate: "2023-11-14",
    seed: scenario.seed ?? 42,
    convergenceThreshold: 0.5,
    // realPrice is only used by the printConfig logger (which we suppress
    // with quiet=true), so any well-formed value works.
    realPrice: { kind: "trades", venues: ["binance"] },
    aggregator: scenario.aggregator,
    label: "sim-test",
    validators: scenario.validators,
  };
  const blocks: BlockMetrics[] = [];
  runSimulation(config, source, (m) => blocks.push(m), true);
  return blocks;
}

/** Print one row per block. Compact monospace columns. */
export function printBlocks(blocks: BlockMetrics[]): void {
  console.log("");
  console.log("  blk | real    | oracle  | dev%    | net | inhTot | author");
  console.log("  ----|---------|---------|---------|-----|--------|--------");
  for (const m of blocks) {
    const row = [
      String(m.block).padStart(3),
      m.realPrice.toFixed(4).padStart(7),
      m.oraclePrice.toFixed(4).padStart(7),
      `${m.deviationPct.toFixed(3)}%`.padStart(7),
      String(m.netDirection).padStart(3),
      String(m.inherentTotal).padStart(6),
      m.authorType,
    ];
    console.log("  " + row.join(" | "));
  }
  console.log("");
}

/** Convenience: a validator group with `count` honest validators reading
 *  the test's fake price path exactly (zero jitter). */
export function honestGroup(count: number): ValidatorGroup {
  return {
    type: "honest",
    count,
    priceSource: { kind: "cross-venue", jitterStdDev: 0 },
  };
}

/** Convenience: a validator group of a specific attacker type, zero jitter. */
export function attackerGroup(type: ValidatorGroup["type"], count: number): ValidatorGroup {
  return {
    type,
    count,
    priceSource: { kind: "cross-venue", jitterStdDev: 0 },
  };
}

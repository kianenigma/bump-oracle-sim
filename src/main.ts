import { parseArgs } from "util";
import { DEFAULT_CONFIG, CANDLE_INTERVAL } from "./config.js";
import type { SimulationConfig, SimulationResult } from "./types.js";
import { fetchCandles } from "./data/fetcher.js";
import { interpolateToBlocks } from "./data/interpolator.js";
import { runSimulation } from "./sim/engine.js";
import { generateChart } from "./viz/chart.js";
import { scenarios, listScenarios } from "./analysis/scenarios.js";

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "start-date": { type: "string", default: DEFAULT_CONFIG.startDate },
    "end-date": { type: "string", default: DEFAULT_CONFIG.endDate },
    epsilon: { type: "string", default: DEFAULT_CONFIG.epsilon.toString() },
    validators: { type: "string", default: String(DEFAULT_CONFIG.validatorCount) },
    malicious: { type: "string", default: String(DEFAULT_CONFIG.maliciousFraction) },
    seed: { type: "string", default: String(DEFAULT_CONFIG.seed) },
    output: { type: "string", default: "output.html" },
    scenario: { type: "string" },
    "fetch-only": { type: "boolean", default: false },
    "author-always-honest": { type: "boolean", default: DEFAULT_CONFIG.authorAlwaysHonest },
    jitter: { type: "string", default: String(DEFAULT_CONFIG.jitterStdDev) },
    "list-scenarios": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(`
Oracle Bump Simulation

Usage: bun run src/main.ts [options]

Options:
  --start-date <YYYY-MM-DD>    Start date (default: ${DEFAULT_CONFIG.startDate})
  --end-date <YYYY-MM-DD>      End date (default: ${DEFAULT_CONFIG.endDate})
  --epsilon <number>      Price epsilon per bump (default: ${DEFAULT_CONFIG.epsilon})
  --validators <number>        Number of validators (default: ${DEFAULT_CONFIG.validatorCount})
  --malicious <fraction>       Fraction of malicious validators 0-1 (default: 0)
  --seed <number>              Random seed (default: ${DEFAULT_CONFIG.seed})
  --output <path>              Output HTML file (default: output.html)
  --scenario <name>            Named scenario (use --list-scenarios to see options)
  --fetch-only                 Only fetch and cache price data, don't simulate
  --author-always-honest       Block author is always honest (default: true)
  --jitter <fraction>          Price jitter std dev as fraction (default: ${DEFAULT_CONFIG.jitterStdDev})
  --list-scenarios             List available named scenarios
  --help                       Show this help
`);
  process.exit(0);
}

if (args["list-scenarios"]) {
  console.log("Available scenarios:", listScenarios().join(", "));
  process.exit(0);
}

const startDate = args["start-date"]!;
const endDate = args["end-date"]!;

// Step 1: Fetch price data
console.log(`\nFetching DOT/USDT data: ${startDate} to ${endDate}`);
const cacheData = await fetchCandles(startDate, endDate, CANDLE_INTERVAL);

if (args["fetch-only"]) {
  console.log(`\nFetch complete. ${cacheData.dataPoints} candles cached.`);
  process.exit(0);
}

// Step 2: Interpolate to 6s blocks
console.log(`\nInterpolating ${cacheData.dataPoints} candles to 6s blocks...`);
const pricePoints = interpolateToBlocks(cacheData.data);
console.log(`  Generated ${pricePoints.length} price points`);

// Step 3: Run simulation(s)
let results: SimulationResult[];

const baseOverrides: Partial<SimulationConfig> = {
  startDate,
  endDate,
  validatorCount: parseInt(args.validators!),
  seed: parseInt(args.seed!),
  authorAlwaysHonest: args["author-always-honest"]!,
  jitterStdDev: parseFloat(args.jitter!),
  epsilon: args.epsilon === "auto" ? "auto" : parseFloat(args.epsilon!),
};

if (args.scenario) {
  const scenarioFn = scenarios[args.scenario];
  if (!scenarioFn) {
    console.error(`Unknown scenario: ${args.scenario}. Available: ${listScenarios().join(", ")}`);
    process.exit(1);
  }
  results = scenarioFn(baseOverrides, pricePoints);
} else {
  // Single run
  const config: SimulationConfig = {
    ...DEFAULT_CONFIG,
    ...baseOverrides,
    maliciousFraction: parseFloat(args.malicious!),
    label: `${(parseFloat(args.malicious!) * 100).toFixed(0)}% malicious`,
  };
  console.log(`\n[Single simulation]`);
  results = [runSimulation(config, pricePoints)];
}

// Step 4: Generate chart
console.log(`\nGenerating chart...`);
await generateChart(results, args.output!);

console.log(`\nDone! Open ${args.output} in a browser to view results.`);

import { parseArgs } from "util";
import { mkdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { DEFAULT_CONFIG, CANDLE_INTERVAL } from "./config.js";
import type { SimulationConfig, SimulationResult, ScenarioMeta, ValidatorMix } from "./types.js";
import { fetchCandles } from "./data/fetcher.js";
import { interpolateToBlocks } from "./data/interpolator.js";
import { runSimulation } from "./sim/engine.js";
import { ChunkWriter, writeIndex } from "./viz/writer.js";
import { startServer } from "./viz/server.js";
import { scenarios, listScenarios } from "./analysis/scenarios.js";

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "start-date": { type: "string", default: DEFAULT_CONFIG.startDate },
    "end-date": { type: "string", default: DEFAULT_CONFIG.endDate },
    epsilon: { type: "string", default: DEFAULT_CONFIG.epsilon.toString() },
    validators: { type: "string", default: String(DEFAULT_CONFIG.validatorCount) },
    mix: { type: "string", default: "" },
    seed: { type: "string", default: String(DEFAULT_CONFIG.seed) },
    output: { type: "string", default: "output.simdata" },
    scenario: { type: "string" },
    "fetch-only": { type: "boolean", default: false },
    jitter: { type: "string", default: String(DEFAULT_CONFIG.jitterStdDev) },
    "convergence-threshold": { type: "string", default: String(DEFAULT_CONFIG.convergenceThreshold) },
    "list-scenarios": { type: "boolean", default: false },
    port: { type: "string", default: "3000" },
    data: { type: "string" },
    "no-open": { type: "boolean", default: false },
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
  --epsilon <number>            Price epsilon per bump (default: ${DEFAULT_CONFIG.epsilon})
  --validators <number>         Number of validators (default: ${DEFAULT_CONFIG.validatorCount})
  --mix <spec>                  Validator mix, e.g. "malicious=0.2,pushy=0.1" (rest are honest)
  --seed <number>               Random seed (default: ${DEFAULT_CONFIG.seed})
  --output <path>               Output directory (default: output.simdata)
  --scenario <name>             Named scenario (use --list-scenarios to see options)
  --fetch-only                  Only fetch and cache price data, don't simulate
  --jitter <fraction>           Price jitter std dev as fraction (default: ${DEFAULT_CONFIG.jitterStdDev})
  --convergence-threshold <%>   Convergence threshold in % (default: ${DEFAULT_CONFIG.convergenceThreshold})
  --list-scenarios              List available named scenarios
  --port <number>               Server port (default: 3000)
  --data <path>                 Serve existing .simdata directory without re-running simulation
  --no-open                     Don't auto-open browser
  --help                        Show this help
`);
  process.exit(0);
}

if (args["list-scenarios"]) {
  console.log("Available scenarios:", listScenarios().join(", "));
  process.exit(0);
}

// Parse --mix "malicious=0.2,pushy=0.1" into ValidatorMix
function parseMix(mixStr: string): ValidatorMix {
  if (!mixStr) return {};
  const mix: ValidatorMix = {};
  for (const part of mixStr.split(",")) {
    const [name, val] = part.split("=");
    if (!name || val === undefined) {
      console.error(`Invalid --mix format: "${part}". Expected "name=fraction".`);
      process.exit(1);
    }
    mix[name.trim()] = parseFloat(val.trim());
  }
  return mix;
}

/** Ensure outputDir is a directory. Error if a file exists at that path. */
function ensureOutputDir(dir: string): void {
  if (existsSync(dir) && !statSync(dir).isDirectory()) {
    console.error(`Error: "${dir}" exists as a file. Please remove it or choose a different --output path.`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
}

// ── Mode: serve existing .simdata directory ──
if (args.data) {
  console.log(`\nLoading simulation data from ${args.data}...`);
  const port = parseInt(args.port!);
  await startServer(args.data, port, !args["no-open"]);
  process.exit(0);
}

// ── Shared: fetch and simulate ──
const startDate = args["start-date"]!;
const endDate = args["end-date"]!;

console.log(`\nFetching DOT/USDT data: ${startDate} to ${endDate}`);
const cacheData = await fetchCandles(startDate, endDate, CANDLE_INTERVAL);

if (args["fetch-only"]) {
  console.log(`\nFetch complete. ${cacheData.dataPoints} candles cached.`);
  process.exit(0);
}

console.log(`\nInterpolating ${cacheData.dataPoints} candles to 6s blocks...`);
const pricePoints = interpolateToBlocks(cacheData.data);
console.log(`  Generated ${pricePoints.length} price points`);

// Determine output directory
const userSetOutput = Bun.argv.slice(2).includes("--output");
let outputDir: string;
if (userSetOutput) {
  outputDir = args.output!;
} else if (args.scenario) {
  outputDir = `${args.scenario}_${startDate}_${endDate}.simdata`;
} else {
  outputDir = args.output!;
}

const baseOverrides: Partial<SimulationConfig> = {
  startDate,
  endDate,
  validatorCount: parseInt(args.validators!),
  seed: parseInt(args.seed!),
  jitterStdDev: parseFloat(args.jitter!),
  epsilon: args.epsilon === "auto" ? "auto" : parseFloat(args.epsilon!),
  convergenceThreshold: parseFloat(args["convergence-threshold"]!),
};

if (args.scenario) {
  const scenarioFn = scenarios[args.scenario];
  if (!scenarioFn) {
    console.error(`Unknown scenario: ${args.scenario}. Available: ${listScenarios().join(", ")}`);
    process.exit(1);
  }
  scenarioFn(baseOverrides, pricePoints, outputDir);
} else {
  // Single simulation
  const mix = parseMix(args.mix!);
  const mixDesc = Object.entries(mix).map(([k, v]) => `${(v * 100).toFixed(0)}% ${k}`).join(", ") || "honest";
  const config: SimulationConfig = {
    ...DEFAULT_CONFIG,
    ...baseOverrides,
    validatorMix: mix,
    label: mixDesc,
  };
  console.log(`\n[Single simulation]`);

  ensureOutputDir(outputDir);
  const scenarioDir = join(outputDir, "scenario_0");
  const writer = new ChunkWriter(scenarioDir);
  const result = runSimulation(config, pricePoints, writer.sink);
  const info = writer.finish();

  const meta: ScenarioMeta = {
    config: result.config,
    summary: result.summary,
    blockCount: info.blockCount,
    chunkCount: info.chunkCount,
    timeRange: info.timeRange,
  };
  writeIndex(outputDir, [meta]);
}

// Start server
const port = parseInt(args.port!);
console.log(`\nStarting visualization server...`);
await startServer(outputDir, port, !args["no-open"]);

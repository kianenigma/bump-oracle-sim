import { parseArgs } from "util";
import { DEFAULT_CONFIG, CANDLE_INTERVAL } from "./config.js";
import type { SimulationConfig, SimulationResult, SimDataFile } from "./types.js";
import { fetchCandles } from "./data/fetcher.js";
import { interpolateToBlocks } from "./data/interpolator.js";
import { runSimulation } from "./sim/engine.js";
import { generateStaticHtml } from "./viz/chart.js";
import { writeSimData } from "./viz/writer.js";
import { toSimData } from "./viz/writer.js";
import { startServer } from "./viz/server.js";
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
    output: { type: "string", default: "output.simdata" },
    scenario: { type: "string" },
    "fetch-only": { type: "boolean", default: false },
    "author-always-honest": { type: "boolean", default: DEFAULT_CONFIG.authorAlwaysHonest },
    jitter: { type: "string", default: String(DEFAULT_CONFIG.jitterStdDev) },
    downsampling: { type: "string", default: "auto" },
    "list-scenarios": { type: "boolean", default: false },
    "export-html": { type: "string" },
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
  --epsilon <number>      Price epsilon per bump (default: ${DEFAULT_CONFIG.epsilon})
  --validators <number>        Number of validators (default: ${DEFAULT_CONFIG.validatorCount})
  --malicious <fraction>       Fraction of malicious validators 0-1 (default: 0)
  --seed <number>              Random seed (default: ${DEFAULT_CONFIG.seed})
  --output <path>              Output file (default: output.simdata)
  --scenario <name>            Named scenario (use --list-scenarios to see options)
  --fetch-only                 Only fetch and cache price data, don't simulate
  --author-always-honest       Block author is always honest (default: true)
  --jitter <fraction>          Price jitter std dev as fraction (default: ${DEFAULT_CONFIG.jitterStdDev})
  --downsampling <none|auto>   Downsample data for HTML export (default: auto)
  --list-scenarios             List available named scenarios
  --export-html <path>         Export self-contained HTML file (old behavior)
  --port <number>              Server port (default: 3000)
  --data <path>                Serve existing .simdata file without re-running simulation
  --no-open                    Don't auto-open browser
  --help                       Show this help
`);
  process.exit(0);
}

if (args["list-scenarios"]) {
  console.log("Available scenarios:", listScenarios().join(", "));
  process.exit(0);
}

// ── Mode: serve existing .simdata file ──
if (args.data) {
  console.log(`\nLoading simulation data from ${args.data}...`);
  const file = Bun.file(args.data);
  if (!(await file.exists())) {
    console.error(`File not found: ${args.data}`);
    process.exit(1);
  }
  const simData: SimDataFile = await file.json();
  console.log(`  ${simData.scenarios.length} scenario(s), ${simData.scenarios[0].timestamps.length} blocks each`);

  const port = parseInt(args.port!);
  await startServer(simData, port, !args["no-open"]);
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
  const config: SimulationConfig = {
    ...DEFAULT_CONFIG,
    ...baseOverrides,
    maliciousFraction: parseFloat(args.malicious!),
    label: `${(parseFloat(args.malicious!) * 100).toFixed(0)}% malicious`,
  };
  console.log(`\n[Single simulation]`);
  results = [runSimulation(config, pricePoints)];
}

// ── Mode: export self-contained HTML ──
if (args["export-html"]) {
  const downsampling = args.downsampling as "none" | "auto";
  console.log(`\nGenerating self-contained HTML (downsampling: ${downsampling})...`);
  await generateStaticHtml(results, args["export-html"], downsampling);
  console.log(`\nDone! Open ${args["export-html"]} in a browser to view results.`);
  process.exit(0);
}

// ── Default mode: write .simdata + start server ──
const outputPath = args.output!;
await writeSimData(results, outputPath);

const simData = toSimData(results);
const port = parseInt(args.port!);
console.log(`\nStarting visualization server...`);
await startServer(simData, port, !args["no-open"]);

import { parseArgs } from "util";
import { mkdirSync, existsSync, statSync, rmSync } from "fs";
import { join } from "path";
import { cpus } from "os";
import { DEFAULT_CONFIG, CANDLE_INTERVAL, ALL_VENUES } from "./config.js";
import { epsilonValue } from "./types.js";
import type { SimulationConfig, SimulationResult, ScenarioMeta, EpsilonSpec, AggregatorConfig, DataSourceSpec, VenueId } from "./types.js";
import { parseMixCli, formatMix } from "./mix.js";
import { loadPriceSource } from "./data/source.js";
import { runSimulation } from "./sim/engine.js";
import { ChunkWriter, writeIndex, loadIndex, scenarioDirName } from "./viz/writer.js";
import { startServer } from "./viz/server.js";
import { scenarios, listScenarios } from "./analysis/scenarios.js";
import { loadCriteria } from "./analysis/research-criteria.js";
import { generateReport } from "./analysis/research-report.js";

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
    label: { type: "string" },
    index: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    reanalyze: { type: "boolean", default: false },
    "no-open": { type: "boolean", default: false },
    threads: { type: "string", default: String(cpus().length) },
    force: { type: "boolean", default: false },
    aggregator: { type: "string" },
    "trimmed-mean-k": { type: "string", default: "0.1" },
    "data-source": { type: "string", default: "candles" },
    venues: { type: "string" },
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
  --epsilon <value>              Epsilon: number (absolute), "auto", or "ratio:0.01" (default: ${DEFAULT_CONFIG.epsilon})
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
  --label <substring>           Filter scenarios by label (case-insensitive substring, use with --data)
  --index <N>                   Filter to a single scenario by index (use with --data)
  --from <YYYY-MM-DD>           View time range start (use with --data)
  --to <YYYY-MM-DD>             View time range end (use with --data)
  --reanalyze                   Re-run scoring/report on existing --data without re-simulating
  --no-open                     Don't auto-open browser
  --threads <number>            Worker threads for batch scenarios (default: CPU count)
  --force                       Overwrite existing output directory
  --aggregator <mode>           Aggregation rule: "nudge" (default), "median", or "trimmed-mean"
  --trimmed-mean-k <fraction>   Fraction trimmed from each tail when using trimmed-mean (default: 0.1)
  --data-source <kind>          "candles" (default, fast) or "trades" (per-trade, multi-venue)
  --venues <list>               Comma-separated venue ids (default: binance). Only used with --data-source=trades.
                                  Available venues: ${ALL_VENUES.join(", ")} (Phase 1: only binance is implemented)
  --help                        Show this help
`);
  process.exit(0);
}

if (args["list-scenarios"]) {
  console.log("Available scenarios:", listScenarios().join(", "));
  process.exit(0);
}


function parseDataSourceArg(kind: string, venuesRaw: string | undefined): DataSourceSpec {
  if (kind === "candles") {
    if (venuesRaw) console.error(`Warning: --venues ignored when --data-source=candles`);
    return { kind: "candles" };
  }
  if (kind === "trades") {
    const list = (venuesRaw ?? "binance").split(",").map((s) => s.trim()).filter(Boolean);
    for (const v of list) {
      if (!ALL_VENUES.includes(v as VenueId)) {
        console.error(`Invalid venue "${v}". Available: ${ALL_VENUES.join(", ")}`);
        process.exit(1);
      }
    }
    if (list.length === 0) {
      console.error(`--data-source=trades requires at least one venue`);
      process.exit(1);
    }
    return { kind: "trades", venues: list as VenueId[] };
  }
  console.error(`Invalid --data-source: "${kind}". Expected: candles, trades.`);
  process.exit(1);
}

function parseAggregatorArg(raw: string | undefined, k: number): AggregatorConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === "nudge") return { kind: "nudge" };
  if (raw === "median") return { kind: "median" };
  if (raw === "trimmed-mean") return { kind: "trimmed-mean", k };
  console.error(`Invalid --aggregator: "${raw}". Expected: nudge, median, trimmed-mean.`);
  process.exit(1);
}

function parseEpsilonArg(raw: string): EpsilonSpec {
  if (raw === "auto") return "auto";
  if (raw.startsWith("ratio:")) {
    const val = parseFloat(raw.slice(6));
    if (isNaN(val)) { console.error(`Invalid ratio epsilon: "${raw}"`); process.exit(1); }
    return { ratio: val };
  }
  const val = parseFloat(raw);
  if (isNaN(val)) { console.error(`Invalid epsilon: "${raw}"`); process.exit(1); }
  return val;
}

/** Ensure outputDir is ready. Error if it already exists (unless --force). */
function ensureOutputDir(dir: string, force: boolean): void {
  if (existsSync(dir)) {
    if (force) {
      rmSync(dir, { recursive: true });
    } else {
      console.error(`Error: "${dir}" already exists. Use --force to overwrite, or remove it manually.`);
      process.exit(1);
    }
  }
  mkdirSync(dir, { recursive: true });
}

// ── Mode: re-run analysis on existing results ──
if (args.reanalyze) {
  if (!args.data) {
    console.error("Error: --reanalyze requires --data <path>");
    process.exit(1);
  }
  const idx = await loadIndex(args.data);
  const criteria = loadCriteria();

  // Reconstruct SimulationResult[] from index
  const results = idx.scenarios.map((s) => ({ config: s.config, summary: s.summary }));

  // Read autoEpsilon from existing report, or derive from stored epsilons
  const reportPath = join(args.data, "research_report.json");
  let autoEpsilon: number;
  if (existsSync(reportPath)) {
    const prev = JSON.parse(await Bun.file(reportPath).text());
    autoEpsilon = prev.autoEpsilon;
  } else {
    // Fallback: assume 1.0x multiplier exists — find the most common epsilon among baseline runs
    const baselines = results.filter((r) => Object.keys(r.config.validatorMix).length === 0);
    const epsilons = baselines.map((r) => epsilonValue(r.config.epsilon));
    autoEpsilon = epsilons.length > 0 ? epsilons[Math.floor(epsilons.length / 2)] : 0.0001;
    console.log(`  Warning: no previous research_report.json found, inferred autoEpsilon=${autoEpsilon.toFixed(6)}`);
  }

  // Reconstruct multiplier map
  const uniqueEpsilons = [...new Set(results.map((r) => epsilonValue(r.config.epsilon)))];
  const epsilonMultipliers = new Map<number, number>();
  for (const eps of uniqueEpsilons) {
    epsilonMultipliers.set(eps, eps / autoEpsilon);
  }

  console.log(`\nRe-analyzing ${results.length} simulations from ${args.data}...`);
  console.log(`  Auto-epsilon: ${autoEpsilon.toFixed(6)}`);
  generateReport(results, epsilonMultipliers, criteria, autoEpsilon, reportPath);
  process.exit(0);
}

// ── Mode: serve existing .simdata directory ──
if (args.data) {
  console.log(`\nLoading simulation data from ${args.data}...`);
  const port = parseInt(args.port!);

  // Resolve --label / --index filters
  let filterIndices: number[] | undefined;
  if (args.label || args.index) {
    const idx = await loadIndex(args.data);
    if (args.index) {
      const i = parseInt(args.index);
      if (isNaN(i) || i < 0 || i >= idx.scenarioCount) {
        console.error(`Error: index ${args.index} out of range (0..${idx.scenarioCount - 1})`);
        process.exit(1);
      }
      filterIndices = [i];
      console.log(`  Filtered to scenario #${i}: "${idx.scenarios[i].config.label}"`);
    } else if (args.label) {
      const needle = args.label.toLowerCase();
      filterIndices = [];
      for (let i = 0; i < idx.scenarioCount; i++) {
        if (idx.scenarios[i].config.label.toLowerCase().includes(needle)) {
          filterIndices.push(i);
        }
      }
      if (filterIndices.length === 0) {
        console.error(`Error: no scenarios match label "${args.label}". Use --data without --label to list all.`);
        process.exit(1);
      }
      console.log(`  Matched ${filterIndices.length} scenario(s) for "${args.label}":`);
      for (const i of filterIndices) {
        console.log(`    #${i}: "${idx.scenarios[i].config.label}"`);
      }
    }
  }

  let timeConstraint: { from: number; to: number } | undefined;
  if (args.from || args.to) {
    const tcFrom = args.from ? Math.floor(new Date(args.from + "T00:00:00Z").getTime() / 1000) : 0;
    const tcTo = args.to ? Math.floor(new Date(args.to + "T23:59:59Z").getTime() / 1000) : Math.floor(Date.now() / 1000);
    if (isNaN(tcFrom) || isNaN(tcTo)) {
      console.error("Error: invalid --from or --to date format (expected YYYY-MM-DD)");
      process.exit(1);
    }
    timeConstraint = { from: tcFrom, to: tcTo };
    console.log(`  Time constraint: ${args.from ?? "start"} to ${args.to ?? "now"}`);
  }

  await startServer(args.data, port, !args["no-open"], filterIndices, timeConstraint);
  process.exit(0);
}

// ── Shared: fetch and simulate ──
const startDate = args["start-date"]!;
const endDate = args["end-date"]!;

const dataSource = parseDataSourceArg(args["data-source"]!, args.venues);

if (dataSource.kind === "candles") {
  console.log(`\nFetching DOT/USDT data (candles): ${startDate} to ${endDate}`);
} else {
  console.log(`\nLoading DOT/USDT data (trades, venues: ${dataSource.venues.join(", ")}): ${startDate} to ${endDate}`);
}

const pricePoints = await loadPriceSource(dataSource, startDate, endDate);

if (args["fetch-only"]) {
  console.log(`\nFetch complete. ${pricePoints.length.toLocaleString()} price points loaded.`);
  process.exit(0);
}

console.log(`  Generated ${pricePoints.length.toLocaleString()} price points`);

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

const aggregatorOverride = parseAggregatorArg(args.aggregator, parseFloat(args["trimmed-mean-k"]!));
const baseOverrides: Partial<SimulationConfig> = {
  startDate,
  endDate,
  validatorCount: parseInt(args.validators!),
  seed: parseInt(args.seed!),
  jitterStdDev: parseFloat(args.jitter!),
  epsilon: parseEpsilonArg(args.epsilon!),
  convergenceThreshold: parseFloat(args["convergence-threshold"]!),
  dataSource,
  ...(aggregatorOverride ? { aggregator: aggregatorOverride } : {}),
};

ensureOutputDir(outputDir, !!args.force);

const threadCount = parseInt(args.threads!);

if (args.scenario) {
  const scenarioFn = scenarios[args.scenario];
  if (!scenarioFn) {
    console.error(`Unknown scenario: ${args.scenario}. Available: ${listScenarios().join(", ")}`);
    process.exit(1);
  }
  await scenarioFn(baseOverrides, pricePoints, outputDir, threadCount);
} else {
  // Single simulation
  const mix = parseMixCli(args.mix!);
  const mixDesc = formatMix(mix);
  const config: SimulationConfig = {
    ...DEFAULT_CONFIG,
    ...baseOverrides,
    validatorMix: mix,
    label: mixDesc,
  };
  console.log(`\n[Single simulation]`);
  const dirName = scenarioDirName(config.label, 0);
  const writer = new ChunkWriter(join(outputDir, dirName));
  const result = runSimulation(config, pricePoints, writer.sink);
  const info = writer.finish();

  const meta: ScenarioMeta = {
    config: result.config,
    summary: result.summary,
    blockCount: info.blockCount,
    chunkCount: info.chunkCount,
    timeRange: info.timeRange,
    chunkTimeRanges: info.chunkTimeRanges,
    dir: dirName,
  };
  writeIndex(outputDir, [meta]);
}

// Start server
const port = parseInt(args.port!);
console.log(`\nStarting visualization server...`);
await startServer(outputDir, port, !args["no-open"]);

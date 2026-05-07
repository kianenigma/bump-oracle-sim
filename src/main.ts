import { parseArgs } from "util";
import { mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { cpus } from "os";
import {
  ALL_VENUES,
  DEFAULT_CONFIG,
  DEFAULT_PRICE_SOURCE,
  DEFAULT_SYNTHETIC_VENUE_JITTER,
  DEFAULT_VALIDATOR_COUNT,
} from "./config.js";
import { epsilonValue } from "./types.js";
import type {
  AggregatorConfig,
  CrossVenueSpec,
  RealPriceSpec,
  EpsilonSpec,
  ScenarioMeta,
  SimulationConfig,
  ValidatorPriceSource,
  VenueId,
} from "./types.js";
import {
  buildValidators,
  formatValidators,
  parseValidatorsCli,
  isBaselineValidators,
} from "./validators.js";
import { loadPriceSource } from "./data/source.js";
import { runSimulation } from "./sim/engine.js";
import { ChunkWriter, CsvWriter, combineSinks, writeIndex, loadIndex, scenarioDirName } from "./viz/writer.js";
import { startServer } from "./viz/server.js";
import { scenarios, listScenarios, type ScenarioCtx } from "./analysis/scenarios.js";
import { loadCriteria } from "./analysis/research-criteria.js";
import { generateReport } from "./analysis/research-report.js";

const DEFAULT_EPSILON: EpsilonSpec = 1 / DEFAULT_VALIDATOR_COUNT / 10;

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "start-date": { type: "string", default: DEFAULT_CONFIG.startDate },
    "end-date": { type: "string", default: DEFAULT_CONFIG.endDate },
    epsilon: { type: "string", default: String(DEFAULT_EPSILON) },
    validators: { type: "string", default: String(DEFAULT_VALIDATOR_COUNT) },
    mix: { type: "string", default: "" },
    seed: { type: "string", default: String(DEFAULT_CONFIG.seed) },
    output: { type: "string", default: "output.simdata" },
    scenario: { type: "string" },
    "fetch-only": { type: "boolean", default: false },
    jitter: { type: "string", default: String(DEFAULT_PRICE_SOURCE.jitterStdDev) },
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
    "aggregator-k": { type: "string", default: "0" },
    "data-source": { type: "string", default: "trades" },
    venues: { type: "string" },
    "cross-venue": { type: "string" },
    "price-source": { type: "string" },
    "synthetic-venue-jitter": { type: "string", default: String(DEFAULT_SYNTHETIC_VENUE_JITTER) },
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
  --epsilon <value>            Epsilon: number (absolute), "auto", or "ratio:0.01"
                                Used when --aggregator=nudge (default: ${DEFAULT_EPSILON})
  --validators <number>        Number of validators (default: ${DEFAULT_VALIDATOR_COUNT})
  --mix <spec>                 Validator mix, e.g. "malicious=0.2,pushy=0.1" (rest are honest)
  --seed <number>              Random seed (default: ${DEFAULT_CONFIG.seed})
  --output <path>              Output directory (default: output.simdata)
  --scenario <name>            Named scenario (use --list-scenarios to see options)
  --fetch-only                 Only fetch and cache price data, don't simulate
  --jitter <fraction>          Price jitter std dev as fraction (default: ${DEFAULT_PRICE_SOURCE.jitterStdDev})
  --convergence-threshold <%>  Convergence threshold in % (default: ${DEFAULT_CONFIG.convergenceThreshold})
  --list-scenarios             List available named scenarios
  --port <number>              Server port (default: 3000)
  --data <path>                Serve existing .simdata directory without re-running simulation
  --label <substring>          Filter scenarios by label (use with --data)
  --index <N>                  Filter to a single scenario by index (use with --data)
  --from <YYYY-MM-DD>          View time range start (use with --data)
  --to <YYYY-MM-DD>            View time range end (use with --data)
  --reanalyze                  Re-run scoring/report on existing --data without re-simulating
  --no-open                    Don't auto-open browser
  --threads <number>           Worker threads for batch scenarios (default: CPU count)
  --force                      Overwrite existing output directory
  --aggregator <mode>          Aggregation rule: "nudge", "median" (default), or "mean"
  --aggregator-k <fraction>    For median/mean: trim this fraction from each tail before aggregating (default: 0).
                                 k=0 → plain median / plain mean. k>0 → trim then median / mean.
  --data-source <kind>         "trades" (default, per-trade multi-venue), "candles" (Binance US 1m),
                                or "synthetic" (deterministic scripted price path; --start-date /
                                --end-date are rejected in this mode).
  --venues <list>              Comma-separated venue ids, or "all" (default).
                                Available venues: ${ALL_VENUES.join(", ")}
  --cross-venue <rule>         How to combine per-venue prices into the ground-truth real price:
                                "mean" (default), "median", "vwap". Only with --data-source=trades.
  --price-source <mode>        "random-venue" (default; random venue per query) or "cross-venue".
                                random-venue requires --data-source=trades.
  --synthetic-venue-jitter <f> Per-venue Gaussian jitter as fraction of price for --data-source=synthetic
                                (default: ${DEFAULT_SYNTHETIC_VENUE_JITTER}). Divergence events use 10× this.
  --help                       Show this help
`);
  process.exit(0);
}

if (args["list-scenarios"]) {
  console.log("Available scenarios:", listScenarios().join(", "));
  process.exit(0);
}

function parsePriceSourceKindArg(raw: string | undefined): "cross-venue" | "random-venue" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "cross-venue" || raw === "random-venue") return raw;
  // Back-compat: old "median" alias for the cross-venue observation mode.
  if (raw === "median") return "cross-venue";
  console.error(`Invalid --price-source: "${raw}". Expected: cross-venue, random-venue.`);
  process.exit(1);
}

function parseCrossVenueArg(raw: string | undefined): CrossVenueSpec {
  if (raw === undefined) return { kind: "mean" };
  if (raw === "mean" || raw === "median" || raw === "vwap") return { kind: raw };
  console.error(`Invalid --cross-venue: "${raw}". Expected: mean, median, vwap.`);
  process.exit(1);
}

function parseVenuesList(venuesRaw: string | undefined, label: string): VenueId[] {
  let list: string[];
  if (!venuesRaw || venuesRaw === "all") {
    list = ALL_VENUES.slice();
  } else {
    list = venuesRaw.split(",").map((s) => s.trim()).filter(Boolean);
    for (const v of list) {
      if (!ALL_VENUES.includes(v as VenueId)) {
        console.error(`Invalid venue "${v}". Available: ${ALL_VENUES.join(", ")}, or "all"`);
        process.exit(1);
      }
    }
  }
  if (list.length === 0) {
    console.error(`--data-source=${label} requires at least one venue`);
    process.exit(1);
  }
  return list as VenueId[];
}

function parseRealPriceArg(
  kind: string,
  venuesRaw: string | undefined,
  crossVenueRaw: string | undefined,
  syntheticJitterRaw: string,
): RealPriceSpec {
  if (kind === "candles") {
    if (venuesRaw) console.error(`Warning: --venues ignored when --data-source=candles`);
    if (crossVenueRaw) console.error(`Warning: --cross-venue ignored when --data-source=candles`);
    return { kind: "candles" };
  }
  if (kind === "trades") {
    return { kind: "trades", venues: parseVenuesList(venuesRaw, "trades"), crossVenue: parseCrossVenueArg(crossVenueRaw) };
  }
  if (kind === "synthetic") {
    if (crossVenueRaw && crossVenueRaw !== "mean") {
      console.error(`Warning: --cross-venue=${crossVenueRaw} ignored when --data-source=synthetic (mean is enforced).`);
    }
    const jitter = parseFloat(syntheticJitterRaw);
    if (isNaN(jitter) || jitter < 0) {
      console.error(`Invalid --synthetic-venue-jitter: "${syntheticJitterRaw}". Expected a non-negative number.`);
      process.exit(1);
    }
    return { kind: "synthetic", venues: parseVenuesList(venuesRaw, "synthetic"), venueJitterStdDev: jitter };
  }
  console.error(`Invalid --data-source: "${kind}". Expected: candles, trades, synthetic.`);
  process.exit(1);
}

function parseAggregatorArg(raw: string | undefined, k: number, epsilon: EpsilonSpec): AggregatorConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === "nudge") return { kind: "nudge", epsilon };
  if (raw === "median") return k > 0 ? { kind: "median", k } : { kind: "median" };
  if (raw === "mean") return k > 0 ? { kind: "mean", k } : { kind: "mean" };
  console.error(`Invalid --aggregator: "${raw}". Expected: nudge, median, mean.`);
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

function variantLabel(d: import("./data/synthetic.js").SyntheticEventDescriptor): string {
  switch (d.variant) {
    case "insync-r20": return "in-sync, recover 20%";
    case "insync-r50": return "in-sync, recover 50%";
    case "insync-r90": return "in-sync, recover 90%";
    case "diverge":    return "diverge (10× venue jitter, full recover)";
  }
}

function printSyntheticEventTable(source: import("./data/synthetic.js").SyntheticSource): void {
  const events = source.events;
  const baseline = events[0]?.startPrice;
  const totalBlocks = source.pricePoints.length;

  console.log(`\nSynthetic event sequence — ${events.length} events, baseline=${baseline.toFixed(4)}, ${totalBlocks.toLocaleString()} blocks (6s each):`);
  console.log("");
  console.log("   #    blocks         direction   variant                                     path (start → extreme → recovered)");
  console.log("  ──── ────────────── ───────────  ─────────────────────────────────────────  ─────────────────────────────────────");
  for (const ev of events) {
    const idx = String(ev.index + 1).padStart(3, " ");
    const blockRange = `${ev.moveStartBlock.toString().padStart(4)}–${ev.postEndBlock.toString().padStart(4)}`.padEnd(13);
    const dir = ev.descriptor.direction === "drop" ? "drop" : "rise";
    const dirCol = `${dir} ${(ev.descriptor.magnitude * 100).toFixed(0).padStart(2)}%`.padEnd(11);
    const variant = variantLabel(ev.descriptor).padEnd(43);
    const path = `${ev.startPrice.toFixed(4)} → ${ev.extremePrice.toFixed(4)} → ${ev.recoveredPrice.toFixed(4)}`;
    console.log(`  ${idx}   ${blockRange}  ${dirCol}  ${variant}  ${path}`);
  }
  console.log("");
}

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

/** Resolved-epsilon helper for reanalyze: pulls the numeric ε out of an
 *  AggregatorConfig (0 for non-nudge). */
function configEpsilon(config: SimulationConfig): number {
  const a = config.aggregator;
  if (!a || a.kind !== "nudge") return 0;
  return epsilonValue(a.epsilon);
}

// ── Mode: re-run analysis on existing results ──────────────────────────────
if (args.reanalyze) {
  if (!args.data) {
    console.error("Error: --reanalyze requires --data <path>");
    process.exit(1);
  }
  const idx = await loadIndex(args.data);
  const criteria = loadCriteria();

  const results = idx.scenarios.map((s) => ({ config: s.config, summary: s.summary }));

  const reportPath = join(args.data, "research_report.json");
  let autoEpsilon: number;
  if (existsSync(reportPath)) {
    const prev = JSON.parse(await Bun.file(reportPath).text());
    autoEpsilon = prev.autoEpsilon;
  } else {
    const baselines = results.filter((r) => isBaselineValidators(r.config.validators));
    const epsilons = baselines.map((r) => configEpsilon(r.config));
    autoEpsilon = epsilons.length > 0 ? epsilons[Math.floor(epsilons.length / 2)] : 0.0001;
    console.log(`  Warning: no previous research_report.json found, inferred autoEpsilon=${autoEpsilon.toFixed(6)}`);
  }

  const uniqueEpsilons = [...new Set(results.map((r) => configEpsilon(r.config)))];
  const epsilonMultipliers = new Map<number, number>();
  for (const eps of uniqueEpsilons) {
    epsilonMultipliers.set(eps, eps / autoEpsilon);
  }

  console.log(`\nRe-analyzing ${results.length} simulations from ${args.data}...`);
  console.log(`  Auto-epsilon: ${autoEpsilon.toFixed(6)}`);
  generateReport(results, epsilonMultipliers, criteria, autoEpsilon, reportPath);
  process.exit(0);
}

// ── Mode: serve existing .simdata directory ────────────────────────────────
if (args.data) {
  console.log(`\nLoading simulation data from ${args.data}...`);
  const port = parseInt(args.port!);

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

// ── Shared: fetch and simulate ─────────────────────────────────────────────

const cliArgs = Bun.argv.slice(2);
const cliPassed = (flag: string) => cliArgs.includes(flag);

const realPrice = parseRealPriceArg(
  args["data-source"]!,
  args.venues,
  args["cross-venue"],
  args["synthetic-venue-jitter"]!,
);

if (realPrice.kind === "synthetic") {
  for (const flag of ["--start-date", "--end-date"]) {
    if (cliPassed(flag)) {
      console.error(`Error: ${flag} is not supported with --data-source=synthetic (synthetic series uses its own deterministic timeline).`);
      process.exit(1);
    }
  }
}

let startDate = args["start-date"]!;
let endDate = args["end-date"]!;
const seedForSource = parseInt(args.seed!);

if (realPrice.kind === "candles") {
  console.log(`\nFetching DOT/USDT data (candles): ${startDate} to ${endDate}`);
} else if (realPrice.kind === "trades") {
  console.log(`\nLoading DOT/USDT data (trades, venues: ${realPrice.venues.join(", ")}, cross-venue=${realPrice.crossVenue?.kind ?? "mean"}): ${startDate} to ${endDate}`);
} else {
  console.log(`\nGenerating synthetic price path (venues: ${realPrice.venues.join(", ")}, venue-jitter=${realPrice.venueJitterStdDev}, seed=${seedForSource})`);
}

const priceSource = await loadPriceSource(realPrice, startDate, endDate, seedForSource);

if (realPrice.kind === "synthetic") {
  // Synthetic source generates its own timestamps; align startDate/endDate
  // strings so output paths and chart labels match the synthesised range.
  const first = priceSource.pricePoints[0]?.timestamp;
  const last = priceSource.pricePoints[priceSource.pricePoints.length - 1]?.timestamp;
  if (first !== undefined && last !== undefined) {
    startDate = new Date(first * 1000).toISOString().slice(0, 10);
    endDate = new Date(last * 1000).toISOString().slice(0, 10);
  }
  printSyntheticEventTable(priceSource as import("./data/synthetic.js").SyntheticSource);
}

if (args["fetch-only"]) {
  console.log(`\nFetch complete. ${priceSource.pricePoints.length.toLocaleString()} price points loaded.`);
  process.exit(0);
}

console.log(`  Generated ${priceSource.pricePoints.length.toLocaleString()} price points`);

// Resolve user knobs
const validatorCount = parseInt(args.validators!);
const seed = parseInt(args.seed!);
const jitterStdDev = parseFloat(args.jitter!);
const convergenceThreshold = parseFloat(args["convergence-threshold"]!);
const epsilon = parseEpsilonArg(args.epsilon!);

// Default validator price-source: random-venue if trades data, cross-venue if candles.
let priceSourceKind = parsePriceSourceKindArg(args["price-source"]);
if (priceSourceKind === undefined) {
  priceSourceKind = realPrice.kind === "candles" ? "cross-venue" : "random-venue";
}
const ctxPriceSource: ValidatorPriceSource = { kind: priceSourceKind, jitterStdDev };

const aggregatorOverride = parseAggregatorArg(
  args.aggregator,
  parseFloat(args["aggregator-k"]!),
  epsilon,
);
const ctxAggregator: AggregatorConfig = aggregatorOverride
  ?? (DEFAULT_CONFIG.aggregator ?? { kind: "median" });

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

ensureOutputDir(outputDir, !!args.force);

const threadCount = parseInt(args.threads!);

if (args.scenario) {
  const scenarioFn = scenarios[args.scenario];
  if (!scenarioFn) {
    console.error(`Unknown scenario: ${args.scenario}. Available: ${listScenarios().join(", ")}`);
    process.exit(1);
  }
  const ctx: ScenarioCtx = {
    startDate,
    endDate,
    seed,
    convergenceThreshold,
    realPrice,
    aggregator: ctxAggregator,
    priceSource: ctxPriceSource,
    validatorCount,
    defaultEpsilon: epsilon,
  };
  await scenarioFn(ctx, priceSource, outputDir, threadCount);
} else {
  // Single simulation
  const parsed = parseValidatorsCli(args.mix!, ctxPriceSource);
  const honestPS: ValidatorPriceSource = parsed.honestJitter !== undefined
    ? { ...ctxPriceSource, jitterStdDev: parsed.honestJitter }
    : ctxPriceSource;
  const validators = buildValidators(validatorCount, parsed.specs, ctxPriceSource, honestPS);
  const config: SimulationConfig = {
    startDate,
    endDate,
    seed,
    convergenceThreshold,
    realPrice,
    aggregator: ctxAggregator,
    label: formatValidators(validators),
    validators,
  };
  console.log(`\n[Single simulation]`);
  const dirName = scenarioDirName(config.label, 0);
  const writer = new ChunkWriter(join(outputDir, dirName));
  const csv = new CsvWriter(join(outputDir, `${dirName}.csv`));
  const result = runSimulation(config, priceSource, combineSinks(writer.sink, csv.sink));
  const info = writer.finish();
  csv.finish();

  const meta: ScenarioMeta = {
    config: result.config,
    summary: result.summary,
    blockCount: info.blockCount,
    chunkCount: info.chunkCount,
    timeRange: info.timeRange,
    chunkTimeRanges: info.chunkTimeRanges,
    dir: dirName,
  };
  writeIndex(outputDir, [meta], priceSource);
}

// Start server
const port = parseInt(args.port!);
console.log(`\nStarting visualization server...`);
await startServer(outputDir, port, !args["no-open"]);

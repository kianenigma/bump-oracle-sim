export enum Bump {
  Up = 1,
  Down = -1,
}

export interface Candle {
  timestamp: number; // Unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PricePoint {
  timestamp: number; // Unix seconds
  price: number;
}

export interface BumpSubmission {
  validatorIndex: number;
  bump: Bump;
}

export interface BlockMetrics {
  block: number;
  timestamp: number;
  realPrice: number;
  oraclePrice: number;
  authorIndex: number;
  authorIsHonest: boolean;
  totalBumps: number;
  activatedBumps: number;
  netDirection: number; // positive = up, negative = down
  deviation: number; // absolute difference real - oracle
  deviationPct: number; // percentage deviation
}

// Per-type entry: plain number = fraction with default jitter, or object for custom jitter.
// Example: 0.33 or { fraction: 0.33, jitter: 0.005 }
export type ValidatorMixEntry = number | { fraction?: number; jitter?: number };

// Maps validator type name to its config.
// "honest" is implicit: its fraction = 1 - sum(all other fractions).
// A "honest" key is allowed to override jitter only (fraction is ignored).
// Example: { malicious: 0.2, pushy: { fraction: 0.1, jitter: 0.005 } }
export type ValidatorMix = Record<string, ValidatorMixEntry>;

export interface SimulationConfig {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  validatorCount: number;
  validatorMix: ValidatorMix; // fractions for non-honest validator types
  epsilon: number | "auto";
  seed: number;
  jitterStdDev: number; // price jitter std dev as fraction (e.g. 0.001 = 0.1%)
  convergenceThreshold: number; // deviation % threshold for convergence (default 0.1)
  label: string;
}

export interface SimulationResult {
  config: SimulationConfig;
  summary: SimulationSummary;
}

export interface SimulationSummary {
  /// Total number of blocks in the simulation
  totalBlocks: number;
  /// The epsilon used in the simulation
  epsilon: number;
  /// The threshold used for convergence (in %), and the convergance itself.
  ///
  /// If set to 1%, blocks in which deviation was less than 1% are counted as converged.
  convergenceThreshold: number;
  convergenceRate: number;
  /// The arithmetic mean (aka. average) deviation in the simulation.
  meanDeviation: number;
  meanDeviationPct: number;
  /// The max deviation in the simulation.
  maxDeviation: number;
  maxDeviationPct: number;
  /// The integral of the deviation over time.
  deviationIntegral: number;
  /// The maximum rate of deviation change.
  maxDeviationRate: number;
  /// Longest consecutive streak of blocks where deviationPct >= convergenceThreshold.
  maxConsecutiveBlocksAboveThreshold: number;
  /// 95th percentile of deviationPct across all blocks.
  p95DeviationPct: number;
  /// 99th percentile of deviationPct across all blocks.
  p99DeviationPct: number;
}

export interface CacheMetadata {
  asset: string;
  quote: string;
  interval: string;
  source: string;
  startDate: string;
  endDate: string;
  dataPoints: number;
  data: Candle[];
}

// ── .simdata directory format (chunked) ──

export const BLOCKS_PER_CHUNK = 1_000_000;

export interface BlockChunk {
  chunkIndex: number;
  blockOffset: number;
  blockCount: number;
  timestamps: number[];
  realPrices: number[];
  oraclePrices: number[];
  deviationPcts: number[];
}

export interface ScenarioMeta {
  config: SimulationConfig;
  summary: SimulationSummary;
  blockCount: number;
  chunkCount: number;
  timeRange: { from: number; to: number };
  /** Per-chunk time ranges for fast chunk skipping (absent in legacy .simdata dirs). */
  chunkTimeRanges?: Array<{ from: number; to: number }>;
  /** Directory name within the .simdata dir (absent in legacy dirs → falls back to scenario_<idx>). */
  dir?: string;
}

export interface SimDataIndex {
  scenarioCount: number;
  scenarios: ScenarioMeta[];
}

// ── API response types ──

export interface OHLCCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface LinePoint {
  time: number;
  value: number;
}

export interface ApiScenarioMeta {
  index: number;
  config: SimulationConfig;
  summary: SimulationSummary;
  timeRange: { from: number; to: number };
  blockCount: number;
}

export interface ApiMetaResponse {
  scenarioCount: number;
  scenarios: ApiScenarioMeta[];
}

export interface ApiOracleData {
  index: number;
  label: string;
  ohlc: OHLCCandle[];
  line: LinePoint[];
  deviation: LinePoint[];
}

export interface ApiDataResponse {
  tf: number;
  requestedTF: number;
  from: number;
  to: number;
  realPrice: {
    ohlc: OHLCCandle[];
    line: LinePoint[];
  };
  oracles: ApiOracleData[];
}

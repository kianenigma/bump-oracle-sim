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

export interface SimulationConfig {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  validatorCount: number;
  maliciousFraction: number; // 0.0 - 1.0
  epsilon: number | "auto";
  seed: number;
  authorAlwaysHonest: boolean;
  jitterStdDev: number; // price jitter std dev as fraction (e.g. 0.001 = 0.1%)
  convergenceThreshold: number; // deviation % threshold for convergence (default 0.1)
  label: string;
}

export interface SimulationResult {
  config: SimulationConfig;
  metrics: BlockMetrics[];
  summary: SimulationSummary;
}

export interface SimulationSummary {
  totalBlocks: number;
  meanDeviation: number;
  maxDeviation: number;
  meanDeviationPct: number;
  maxDeviationPct: number;
  epsilon: number;
  convergenceRate: number; // fraction of blocks where deviation < threshold
  convergenceThreshold: number; // the threshold used (in %)
  deviationIntegral: number; // integral of deviationPct over time (%-seconds)
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

// ── .simdata file format (columnar JSON) ──

export interface SimDataScenario {
  config: SimulationConfig;
  summary: SimulationSummary;
  timestamps: number[];
  realPrices: number[];
  oraclePrices: number[];
  deviationPcts: number[];
}

export interface SimDataFile {
  version: 1;
  scenarios: SimDataScenario[];
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

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
  convergenceRate: number; // fraction of blocks where deviation < 1%
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

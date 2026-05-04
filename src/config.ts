import type { MaliciousParams, SimulationConfig } from "./types.js";

export const DEFAULT_MALICIOUS_PARAMS: MaliciousParams = {
  delayBlocks: 10,         // 60s at 6s blocks
  pushyQuoteBias: 0.05,    // 5% outlier in motion direction (quote mode)
  driftQuoteStep: 0.001,   // 0.1% upward bias per block (quote mode)
};

export const DEFAULT_CONFIG: SimulationConfig = {
  startDate: "2025-01-01",
  endDate: "2025-01-07",
  validatorCount: 300,
  validatorMix: {}, // 100% honest by default
  epsilon: 1 / 300 / 10, // price can move at most a 0.1$ per block
  seed: 42,
  jitterStdDev: 0.001, // 0.1% price jitter
  convergenceThreshold: 0.5, // 0.5% deviation threshold for convergence
  label: "default",
  aggregator: { kind: "nudge" },
  maliciousParams: DEFAULT_MALICIOUS_PARAMS,
};

export const BLOCK_TIME_SECONDS = 6;
export const BINANCE_BASE_URL = "https://api.binance.us/api/v3/klines";
export const BINANCE_BATCH_LIMIT = 1000;
export const CANDLE_INTERVAL = "1m";
export const CANDLE_INTERVAL_MS = 60_000;

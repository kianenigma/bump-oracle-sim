import type { SimulationConfig } from "./types.js";

export const DEFAULT_CONFIG: SimulationConfig = {
  startDate: "2025-01-01",
  endDate: "2025-01-07",
  validatorCount: 300,
  maliciousFraction: 0,
  epsilon: 1 / 300 / 10, // price can move at most a 0.1$ per block
  seed: 42,
  authorAlwaysHonest: true,
  jitterStdDev: 0.001, // 0.1% price jitter
  label: "default",
};

export const BLOCK_TIME_SECONDS = 6;
export const BINANCE_BASE_URL = "https://api.binance.us/api/v3/klines";
export const BINANCE_BATCH_LIMIT = 1000;
export const CANDLE_INTERVAL = "1m";
export const CANDLE_INTERVAL_MS = 60_000;

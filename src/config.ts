import type {
  SimulationConfig,
  ValidatorGroup,
  ValidatorParams,
  ValidatorPriceSource,
  VenueId,
} from "./types.js";

// All venues currently supported by the trade-data pipeline.
export const ALL_VENUES: VenueId[] = ["binance", "kraken", "bybit", "gate", "okx", "coinbase"];

// Default per-group price observation: each query picks a random venue with
// 0.1% Gaussian jitter on top. Folded into every group unless a group's
// `priceSource` overrides it.
export const DEFAULT_PRICE_SOURCE: ValidatorPriceSource = {
  kind: "random-venue",
  jitterStdDev: 0.001,
};

// Defaults for the type-specific param keys. Engine fills these in when a
// group's `params` is missing or partial.
export const DEFAULT_VALIDATOR_PARAMS: Required<ValidatorParams> = {
  delayBlocks: 10,             // 60s at 6s blocks
  pushyQuoteBias: 0.1,        // 5% outlier in motion direction (quote mode)
  maliciousQuoteBias: 0.1,    // 5% outlier OPPOSITE motion (quote mode)
  driftQuoteStep: 0.1,       // 0.1% upward bias per block (quote mode)
  withholderDirection: "up",  // suppress upward oracle moves by default
};

// How often to snapshot the confidence vector into BlockMetrics. With a 6s
// block time, 600 blocks ≈ 1h. The snapshots feed the UI confidence chart;
// finer sampling = bigger .simdata. Storage: ~600 samples/h × 24h × 10d × N
// floats ≈ 70MB at N=300, well within reason.
export const CONFIDENCE_SAMPLE_INTERVAL = 600;

export const DEFAULT_VALIDATOR_COUNT = 300;

// 100% honest baseline at the default count and price source.
const DEFAULT_VALIDATORS: ValidatorGroup[] = [
  { type: "honest", count: DEFAULT_VALIDATOR_COUNT, priceSource: DEFAULT_PRICE_SOURCE },
];

export const DEFAULT_CONFIG: SimulationConfig = {
  startDate: "2025-01-01",
  endDate: "2025-01-07",
  validators: DEFAULT_VALIDATORS,
  seed: 42,
  convergenceThreshold: 0.5, // 0.5% deviation threshold for convergence
  label: "default",
  aggregator: { kind: "median" },
  // Realistic default: validators query individual venues (random per query)
  // and the cross-venue MEAN is the ground truth.
  realPrice: { kind: "trades", venues: ALL_VENUES, crossVenue: { kind: "mean" } },
};

export const BLOCK_TIME_SECONDS = 6;
export const BINANCE_BASE_URL = "https://api.binance.us/api/v3/klines";
export const BINANCE_BATCH_LIMIT = 1000;
export const CANDLE_INTERVAL = "1m";
export const CANDLE_INTERVAL_MS = 60_000;

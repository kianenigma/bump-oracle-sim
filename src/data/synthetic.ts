import type { PricePoint, ResolvedPriceSource, VenueId } from "../types.js";
import {
  BLOCK_TIME_SECONDS,
  SYNTHETIC_BASE_TIMESTAMP,
  SYNTHETIC_DIVERGE_MULTIPLIER,
} from "../config.js";
import { mulberry32, gaussianRandom } from "../rng.js";

// ── Event matrix ────────────────────────────────────────────────────────────
// 24 events: 2 directions × 3 magnitudes × (3 in-sync recoveries + 1 diverge).
// In-sync variants recover X% of the move (recover=0.2 → ends at start ± m·0.8).
// Diverge variant always fully recovers (recover=1.0) but uses 10× venue jitter
// during move + hold-at-extreme phases.

export type SyntheticDirection = "drop" | "increase";
export type SyntheticVariant = "insync-r20" | "insync-r50" | "insync-r90" | "diverge";

export interface SyntheticEventDescriptor {
  direction: SyntheticDirection;
  magnitude: number;     // fraction of baseline: 0.10 | 0.30 | 0.70
  variant: SyntheticVariant;
  recovery: number;      // fraction of the move recovered: 0.2 | 0.5 | 0.9 | 1.0
}

const MAGNITUDES = [0.10, 0.30, 0.70];
const INSYNC_RECOVERIES: Array<{ variant: SyntheticVariant; recovery: number }> = [
  { variant: "insync-r20", recovery: 0.20 },
  { variant: "insync-r50", recovery: 0.50 },
  { variant: "insync-r90", recovery: 0.90 },
];

/** The canonical 24-event sequence, ordered drops-first then rises, with
 *  magnitudes ascending small-to-large within each direction and in-sync
 *  variants before divergence. */
export function buildSyntheticEvents(): SyntheticEventDescriptor[] {
  const events: SyntheticEventDescriptor[] = [];
  for (const dir of ["drop", "increase"] as SyntheticDirection[]) {
    for (const m of MAGNITUDES) {
      for (const r of INSYNC_RECOVERIES) {
        events.push({ direction: dir, magnitude: m, variant: r.variant, recovery: r.recovery });
      }
      events.push({ direction: dir, magnitude: m, variant: "diverge", recovery: 1.0 });
    }
  }
  return events;
}

// ── Phase config ────────────────────────────────────────────────────────────

export interface SyntheticPhaseLengths {
  preBlocks: number;
  moveBlocks: number;
  holdBlocks: number;
  recoveryBlocks: number;
  postBlocks: number;
  interEventBlocks: number;
}

export const DEFAULT_PHASE_LENGTHS: SyntheticPhaseLengths = {
  preBlocks: 20,
  moveBlocks: 10,
  holdBlocks: 20,
  recoveryBlocks: 10,
  postBlocks: 20,
  interEventBlocks: 30,
};

/** Stochastic-path parameters. The mean path is built in **log-price space**
 *  (geometric Brownian motion) so noise is multiplicative — a 0.5% wobble
 *  scales with the current level, which is how real asset prices behave
 *  (`dS = μS dt + σS dW`). Brownian bridges fill the transitional phases (so
 *  the path lands exactly on the target extreme/recovered value, modulo float
 *  ε) and a discrete Ornstein–Uhlenbeck process fills hold phases (mean-
 *  reverting around the target log-level). */
export interface SyntheticPathStochastics {
  /** Per-step log-price stddev for Brownian bridges. The bridge's mid-phase
   *  log-stddev is roughly `bridgeStepStdDev · sqrt(phase/4)`. */
  bridgeStepStdDev: number;
  /** Stationary log-stddev of the OU hold process (≈ percent wobble). */
  holdStationaryStdDev: number;
  /** OU autocorrelation: `α` in `y[k]=μ+α(y[k-1]-μ)+ε`. Closer to 1 = more
   *  momentum / slower mean reversion; 0 = i.i.d. Gaussian around level. */
  holdAutocorrelation: number;
}

export const DEFAULT_PATH_STOCHASTICS: SyntheticPathStochastics = {
  bridgeStepStdDev: 0.010,         // 1.0% log-step — moves carry visible texture
  holdStationaryStdDev: 0.010,     // 1.0% multiplicative wobble around hold levels
  holdAutocorrelation: 0.80,       // some momentum, fast enough mean-reversion
                                   // that holds don't drift far from the level
};

export interface SyntheticConfig {
  venues: VenueId[];
  venueJitterStdDev: number;
  baseline?: number;
  seed: number;
  phaseLengths?: Partial<SyntheticPhaseLengths>;
  stochastics?: Partial<SyntheticPathStochastics>;
}

/** Per-block tag so we know which jitter regime to apply. "diverge-hot" is the
 *  move + hold-at-extreme of a divergence event (10× jitter); everything else
 *  is "normal" (1× jitter). */
type JitterRegime = "normal" | "diverge-hot";

/** Block-level metadata for a single event in the synthetic sequence. Derived
 *  purely from the phase lengths and event descriptors — fully deterministic,
 *  independent of RNG, so callers can preview the layout for printing or to
 *  align overlays with phase boundaries on the chart. */
export interface SyntheticEventSpan {
  index: number;                 // 0-based event index
  descriptor: SyntheticEventDescriptor;
  /** First block of the move phase. */
  moveStartBlock: number;
  /** Block where the extreme is reached (last block of the move phase). */
  extremeBlock: number;
  /** First block of the recovery phase. */
  recoveryStartBlock: number;
  /** Block where the recovered level is reached (last block of the recovery). */
  recoveredBlock: number;
  /** Last block of the post-event hold (before the inter-event drift starts). */
  postEndBlock: number;
  /** Deterministic price targets — actual emitted prices wobble around these
   *  due to bridge/OU noise; bridges still hit `extremePrice` and `recoveredPrice`
   *  at `extremeBlock` / `recoveredBlock` exactly, modulo float ε. */
  startPrice: number;
  extremePrice: number;
  recoveredPrice: number;
}

/** What `generateSyntheticSource` returns: standard `ResolvedPriceSource`
 *  fields plus the synthesised date strings and event-span layout. */
export interface SyntheticSource extends ResolvedPriceSource {
  startDate: string;
  endDate: string;
  events: SyntheticEventSpan[];
}

/** Compute event block boundaries deterministically from the phase config.
 *  Mirrors the phase order in `buildMeanPath`: anchor (1) → for each event:
 *  preBlocks → move → holdBlocks → recovery → postBlocks → (interEvent unless last). */
export function computeEventSpans(
  events: SyntheticEventDescriptor[],
  phases: SyntheticPhaseLengths,
  baseline: number,
): SyntheticEventSpan[] {
  const scaledDuration = (base: number, magnitude: number): number =>
    Math.max(base, Math.ceil(base * Math.sqrt(magnitude / 0.10)));

  const spans: SyntheticEventSpan[] = [];
  let cursor = 1; // index 0 holds the initial baseline anchor

  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei];
    const sign = ev.direction === "drop" ? -1 : 1;
    const startPrice = baseline;
    const extremePrice = startPrice + sign * ev.magnitude * startPrice;
    const recoveredPrice = startPrice + sign * ev.magnitude * startPrice * (1 - ev.recovery);
    const moveBlocks = scaledDuration(phases.moveBlocks, ev.magnitude);
    const recoveryBlocks = scaledDuration(phases.recoveryBlocks, ev.magnitude);

    cursor += phases.preBlocks;
    const moveStartBlock = cursor;
    const extremeBlock = cursor + moveBlocks - 1;
    cursor = extremeBlock + 1;
    cursor += phases.holdBlocks;
    const recoveryStartBlock = cursor;
    const recoveredBlock = cursor + recoveryBlocks - 1;
    cursor = recoveredBlock + 1;
    cursor += phases.postBlocks;
    const postEndBlock = cursor - 1;

    spans.push({
      index: ei, descriptor: ev,
      moveStartBlock, extremeBlock, recoveryStartBlock, recoveredBlock, postEndBlock,
      startPrice, extremePrice, recoveredPrice,
    });

    if (ei < events.length - 1) cursor += phases.interEventBlocks;
  }
  return spans;
}

// ── Generator ───────────────────────────────────────────────────────────────

/** Build the designed mean price array and per-block jitter regime tags by
 *  walking through every event + inter-event filler.
 *
 *  Path model: stochastic processes whose endpoint distributions match the
 *  deterministic event invariants.
 *    - Transitional phases (move, recovery, inter-event drift) use a
 *      Brownian bridge from `from` to `to` — `B(t) = drift(t) + (W_t − (t/T)W_T)`
 *      — which lands exactly on `to` while looking like a real walk in between.
 *    - Hold phases (pre, extreme, post) use a discrete Ornstein–Uhlenbeck
 *      process around the target level — mean-reverting Gaussian noise.
 *  Both run on the same RNG, so the whole series is reproducible from `seed`. */
function buildMeanPath(
  events: SyntheticEventDescriptor[],
  baseline: number,
  phases: SyntheticPhaseLengths,
  stoch: SyntheticPathStochastics,
  rng: () => number,
): { mean: number[]; regime: JitterRegime[] } {
  const mean: number[] = [];
  const regime: JitterRegime[] = [];

  // All processes run in log-price space (GBM): noise is multiplicative.
  const sigmaBridge = stoch.bridgeStepStdDev;
  const sigmaHold = stoch.holdStationaryStdDev;
  const alpha = stoch.holdAutocorrelation;
  const ouEpsilon = sigmaHold * Math.sqrt(1 - alpha * alpha);

  // The path is built incrementally; every emit advances `lastValue`. Each
  // phase continues from `lastValue`, so phase boundaries are continuous
  // (no snap from where OU drifted to back to the deterministic target).
  let lastValue = baseline;
  const push = (value: number, reg: JitterRegime) => {
    mean.push(value);
    regime.push(reg);
    lastValue = value;
  };

  /** Brownian bridge in log-price from the current `lastValue` to `to`. The
   *  last emitted block lands on `to` exactly (modulo float ε), regardless of
   *  where the OU drifted to before — so events still hit their target
   *  extremes. */
  const bridge = (to: number, count: number, reg: JitterRegime) => {
    if (count <= 0) return;
    const yA = Math.log(lastValue);
    const yB = Math.log(to);
    const Ws = new Float64Array(count + 1);
    let W = 0;
    for (let i = 1; i <= count; i++) {
      W += gaussianRandom(rng, 0, sigmaBridge);
      Ws[i] = W;
    }
    const Wt = Ws[count];
    for (let k = 1; k <= count; k++) {
      const driftY = yA + (yB - yA) * (k / count);
      const bridgePart = Ws[k] - (k / count) * Wt;
      push(Math.exp(driftY + bridgePart), reg);
    }
  };

  /** OU hold around `level` for `count` blocks (log-space, multiplicative).
   *  Starts from the current `lastValue` (not snapping to `level`) so the
   *  hold flows out of the previous phase's end. */
  const ouHold = (level: number, count: number, reg: JitterRegime) => {
    const muY = Math.log(level);
    let y = Math.log(lastValue);
    for (let i = 0; i < count; i++) {
      y = muY + (y - muY) * alpha + gaussianRandom(rng, 0, ouEpsilon);
      push(Math.exp(y), reg);
    }
  };

  // Move/recovery duration scales sub-linearly with magnitude — a 70% move
  // takes longer than a 10% one but not 7× as long. Reference is the 10%
  // event; bigger events stretch by sqrt(m/0.10).
  const scaledDuration = (base: number, magnitude: number): number =>
    Math.max(base, Math.ceil(base * Math.sqrt(magnitude / 0.10)));

  // Initial baseline anchor.
  push(baseline, "normal");

  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei];
    const sign = ev.direction === "drop" ? -1 : 1;
    const start = baseline;
    const extreme = start + sign * ev.magnitude * start;
    const end = start + sign * ev.magnitude * start * (1 - ev.recovery);
    const moveReg: JitterRegime = ev.variant === "diverge" ? "diverge-hot" : "normal";

    const moveBlocks = scaledDuration(phases.moveBlocks, ev.magnitude);
    const recoveryBlocks = scaledDuration(phases.recoveryBlocks, ev.magnitude);

    ouHold(start, phases.preBlocks, "normal");
    bridge(extreme, moveBlocks, moveReg);
    ouHold(extreme, phases.holdBlocks, moveReg);
    bridge(end, recoveryBlocks, "normal");
    ouHold(end, phases.postBlocks, "normal");

    if (ei < events.length - 1) {
      bridge(baseline, phases.interEventBlocks, "normal");
    }
  }
  return { mean, regime };
}

/** Generate a deterministic synthetic price series and per-venue series whose
 *  per-block mean equals the designed real price. */
export function generateSyntheticSource(cfg: SyntheticConfig): SyntheticSource {
  if (cfg.venues.length === 0) {
    throw new Error("generateSyntheticSource: at least one venue required");
  }
  const baseline = cfg.baseline ?? 2;
  const phases: SyntheticPhaseLengths = { ...DEFAULT_PHASE_LENGTHS, ...(cfg.phaseLengths ?? {}) };
  const stoch: SyntheticPathStochastics = { ...DEFAULT_PATH_STOCHASTICS, ...(cfg.stochastics ?? {}) };
  const rng = mulberry32(cfg.seed);

  const events = buildSyntheticEvents();
  const { mean, regime } = buildMeanPath(events, baseline, phases, stoch, rng);
  const N = mean.length;

  const pricePoints: PricePoint[] = new Array(N);
  for (let i = 0; i < N; i++) {
    pricePoints[i] = { timestamp: SYNTHETIC_BASE_TIMESTAMP + i * BLOCK_TIME_SECONDS, price: mean[i] };
  }

  // Per-venue: independent Gaussian noise scaled by the regime, then mean-zero
  // corrected per-block so cross-venue mean equals the designed `mean[i]` exactly.
  const venuePrices: Record<VenueId, number[]> = {} as Record<VenueId, number[]>;
  for (const v of cfg.venues) venuePrices[v] = new Array(N);

  const noise = new Float64Array(cfg.venues.length);
  for (let i = 0; i < N; i++) {
    const sigma = (regime[i] === "diverge-hot" ? SYNTHETIC_DIVERGE_MULTIPLIER : 1) * cfg.venueJitterStdDev * mean[i];
    let sum = 0;
    for (let k = 0; k < cfg.venues.length; k++) {
      const n = gaussianRandom(rng, 0, sigma);
      noise[k] = n;
      sum += n;
    }
    const correction = sum / cfg.venues.length;
    for (let k = 0; k < cfg.venues.length; k++) {
      venuePrices[cfg.venues[k]][i] = mean[i] + (noise[k] - correction);
    }
  }

  const startDate = isoDate(pricePoints[0].timestamp);
  const endDate = isoDate(pricePoints[N - 1].timestamp);
  const eventSpans = computeEventSpans(events, phases, baseline);
  return { pricePoints, venuePrices, startDate, endDate, events: eventSpans };
}

function isoDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

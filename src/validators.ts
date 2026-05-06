import type {
  ValidatorGroup,
  ValidatorPriceSource,
  ValidatorType,
  ValidatorParams,
} from "./types.js";

// ── Builders ────────────────────────────────────────────────────────────────

/** Spec for a single non-honest group when calling buildValidators. */
export interface GroupSpec {
  type: Exclude<ValidatorType, "honest">;
  fraction: number;
  /** Per-group price-source override; falls back to `defaultPriceSource`. */
  priceSource?: ValidatorPriceSource;
  /** Per-group params override; engine fills in type-specific defaults. */
  params?: ValidatorParams;
}

/**
 * Build a `validators` array from a fraction-based spec.
 *
 * - The honest group is auto-derived as the remainder (count = total − Σ specs).
 * - Each non-honest group gets `priceSource` (group override → default) and
 *   `params` if provided. Groups with count == 0 are dropped.
 *
 * Throws if fractions sum to > 1.0.
 */
export function buildValidators(
  total: number,
  specs: GroupSpec[],
  defaultPriceSource: ValidatorPriceSource,
  honestPriceSource?: ValidatorPriceSource,
): ValidatorGroup[] {
  const out: ValidatorGroup[] = [];
  let nonHonest = 0;
  for (const s of specs) {
    const count = Math.floor(total * s.fraction);
    if (count === 0) continue;
    out.push({
      type: s.type,
      count,
      priceSource: s.priceSource ?? defaultPriceSource,
      ...(s.params ? { params: s.params } : {}),
    });
    nonHonest += count;
  }
  const honestCount = total - nonHonest;
  if (honestCount < 0) {
    throw new Error(
      `buildValidators: non-honest fractions sum to >1 (total=${total}, claimed=${nonHonest}).`,
    );
  }
  // Honest group is always emitted first, even if 0 — keeps the array
  // non-empty for all-malicious edge cases? No, drop it if 0.
  if (honestCount > 0) {
    out.unshift({
      type: "honest",
      count: honestCount,
      priceSource: honestPriceSource ?? defaultPriceSource,
    });
  }
  return out;
}

// ── Inspectors ──────────────────────────────────────────────────────────────

export function totalValidators(validators: ValidatorGroup[]): number {
  let n = 0;
  for (const g of validators) n += g.count;
  return n;
}

/** True iff there is no non-honest group with count > 0. */
export function isBaselineValidators(validators: ValidatorGroup[]): boolean {
  for (const g of validators) {
    if (g.type !== "honest" && g.count > 0) return false;
  }
  return true;
}

/** Sum the count of all groups of a given type. */
export function countOfType(
  validators: ValidatorGroup[],
  type: ValidatorType,
): number {
  let n = 0;
  for (const g of validators) if (g.type === type) n += g.count;
  return n;
}

/** Fraction of validators of a given type, relative to the total set. */
export function fractionOfType(
  validators: ValidatorGroup[],
  type: ValidatorType,
): number {
  const total = totalValidators(validators);
  if (total === 0) return 0;
  return countOfType(validators, type) / total;
}

/**
 * True iff the only non-honest type present is `type` and its fraction is
 * within `tolerance` of `target`. Used by research scoring to detect the
 * "33% adversarial" rows in a sweep.
 */
export function hasGroupAtFraction(
  validators: ValidatorGroup[],
  type: Exclude<ValidatorType, "honest">,
  target: number,
  tolerance = 0.01,
): boolean {
  let typeCount = 0;
  let otherNonHonest = 0;
  let total = 0;
  for (const g of validators) {
    total += g.count;
    if (g.type === type) typeCount += g.count;
    else if (g.type !== "honest") otherNonHonest += g.count;
  }
  if (total === 0) return false;
  if (otherNonHonest > 0) return false;
  return Math.abs(typeCount / total - target) < tolerance;
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** Compact label like "20% malicious" or "10% pushy, 5% drift" or
 *  "100% honest" / "0% (baseline)". Used for scenario labels and tooltips. */
export function formatValidators(validators: ValidatorGroup[]): string {
  const total = totalValidators(validators);
  if (total === 0) return "(empty)";
  const parts: string[] = [];
  for (const g of validators) {
    if (g.type === "honest") continue;
    const pct = (g.count / total) * 100;
    parts.push(`${pct.toFixed(0)}% ${g.type}`);
  }
  return parts.length > 0 ? parts.join(", ") : "0% (baseline)";
}

// ── CLI parsing ─────────────────────────────────────────────────────────────

/**
 * Parse CLI --mix string into GroupSpec[].
 * Format: "name=fraction[:jitter],..."
 *   - fraction : non-honest fraction in [0, 1]
 *   - :jitter  : optional override of priceSource.jitterStdDev for this group
 *
 * Examples:
 *   "malicious=0.33"             → [{ type:"malicious", fraction:0.33 }]
 *   "malicious=0.33:0.005"       → [{ type:"malicious", fraction:0.33,
 *                                      priceSource: <default with jitter=0.005> }]
 *   "honest=:0.005"              → caller should plumb honest jitter separately;
 *                                   "honest" entries here are jitter-only and
 *                                   returned as a special marker (fraction=0).
 *
 * Returns { specs, honestJitter } so the caller can override the honest
 * group's priceSource jitter independently when calling buildValidators.
 */
export interface ParsedMix {
  specs: GroupSpec[];
  honestJitter?: number;
}

export function parseValidatorsCli(
  str: string,
  defaultPriceSource: ValidatorPriceSource,
): ParsedMix {
  if (!str) return { specs: [] };
  const specs: GroupSpec[] = [];
  let honestJitter: number | undefined;

  for (const part of str.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) {
      console.error(`Invalid --mix format: "${part}". Expected "name=fraction" or "name=fraction:jitter".`);
      process.exit(1);
    }
    const name = part.slice(0, eqIdx).trim();
    const valueStr = part.slice(eqIdx + 1).trim();

    const colonIdx = valueStr.indexOf(":");
    let fraction: number;
    let jitter: number | undefined;
    if (colonIdx === -1) {
      fraction = parseFloat(valueStr);
    } else {
      const fracStr = valueStr.slice(0, colonIdx);
      const jitterStr = valueStr.slice(colonIdx + 1);
      fraction = fracStr ? parseFloat(fracStr) : 0;
      jitter = parseFloat(jitterStr);
      if (isNaN(jitter)) {
        console.error(`Invalid jitter in --mix: "${part}".`);
        process.exit(1);
      }
    }
    if (isNaN(fraction)) {
      console.error(`Invalid fraction in --mix: "${part}".`);
      process.exit(1);
    }

    if (name === "honest") {
      honestJitter = jitter;
      continue;
    }

    if (!isValidatorType(name) || name === "honest") {
      console.error(`Unknown validator type "${name}" in --mix. Available: malicious, pushy, noop, delayed, drift, withholder, bias-injector, overshoot-ratchet, stealth-withholder, convergent-cabal, inband-shifter.`);
      process.exit(1);
    }

    const spec: GroupSpec = { type: name, fraction };
    if (jitter !== undefined) {
      spec.priceSource = { ...defaultPriceSource, jitterStdDev: jitter };
    }
    specs.push(spec);
  }

  return { specs, honestJitter };
}

function isValidatorType(s: string): s is ValidatorType {
  return s === "honest" || s === "malicious" || s === "pushy" || s === "noop"
    || s === "delayed" || s === "drift" || s === "withholder" || s === "bias-injector"
    || s === "overshoot-ratchet" || s === "stealth-withholder" || s === "convergent-cabal"
    || s === "inband-shifter";
}

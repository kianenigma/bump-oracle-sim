import type {
  AggregatorMode,
  ValidatorGroup,
  ValidatorPriceSource,
  ValidatorType,
  ValidatorParams,
} from "./types.js";
import { VALIDATOR_REGISTRY } from "./sim/registry.js";

// ── Compatibility ──────────────────────────────────────────────────────────
// Every validator class declares its own `static readonly compatibleEngines`.
// The engine reads it off the constructor via `VALIDATOR_REGISTRY`, so there
// is no parallel metadata table to keep in sync — adding a new validator
// only requires adding its class + a registry entry.

/** True iff a validator of `type` can run under aggregator `mode`. */
export function isCompatibleWithAggregator(
  type: ValidatorType,
  mode: AggregatorMode,
): boolean {
  return VALIDATOR_REGISTRY[type].compatibleEngines.includes(mode);
}

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


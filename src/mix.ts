import type { ValidatorMix, ValidatorMixEntry } from "./types.js";

/** Extract fraction from a mix entry (0 if omitted in object form). */
export function mixFraction(entry: ValidatorMixEntry): number {
  return typeof entry === "number" ? entry : (entry.fraction ?? 0);
}

/** Extract jitter from a mix entry, falling back to the global default. */
export function mixJitter(entry: ValidatorMixEntry, defaultJitter: number): number {
  if (typeof entry === "number") return defaultJitter;
  return entry.jitter ?? defaultJitter;
}

/**
 * True if the mix has no non-honest type with a positive fraction.
 * A mix like { honest: { jitter: 0.005 } } is still a baseline.
 */
export function isBaselineMix(mix: ValidatorMix): boolean {
  for (const [name, entry] of Object.entries(mix)) {
    if (name === "honest") continue;
    if (mixFraction(entry) > 0) return false;
  }
  return true;
}

/**
 * True if the mix has exactly one non-honest type whose fraction is ~target.
 */
export function hasAdversaryAtFraction(mix: ValidatorMix, target: number, tolerance = 0.01): boolean {
  const adversaries = Object.entries(mix).filter(([name]) => name !== "honest");
  if (adversaries.length !== 1) return false;
  return Math.abs(mixFraction(adversaries[0][1]) - target) < tolerance;
}

/** Format a mix for display. */
export function formatMix(mix: ValidatorMix): string {
  const parts: string[] = [];
  for (const [name, entry] of Object.entries(mix)) {
    if (name === "honest") {
      const j = typeof entry !== "number" ? entry.jitter : undefined;
      if (j !== undefined) parts.push(`honest(jitter=${j})`);
      continue;
    }
    const frac = mixFraction(entry);
    const j = typeof entry !== "number" ? entry.jitter : undefined;
    const label = `${(frac * 100).toFixed(0)}% ${name}`;
    parts.push(j !== undefined ? `${label}(jitter=${j})` : label);
  }
  return parts.length > 0 ? parts.join(", ") : "0% (baseline)";
}

/**
 * Parse CLI --mix string into a ValidatorMix.
 * Format: "name=fraction:jitter,name=fraction:jitter,..."
 * - fraction can be omitted (defaults to 0, useful for "honest=:0.005")
 * - :jitter is optional
 * Examples:
 *   "malicious=0.33"              → { malicious: 0.33 }
 *   "malicious=0.33:0.005"        → { malicious: { fraction: 0.33, jitter: 0.005 } }
 *   "honest=:0.005"               → { honest: { jitter: 0.005 } }
 *   "malicious=0.2,honest=:0.005" → { malicious: 0.2, honest: { jitter: 0.005 } }
 */
export function parseMixCli(str: string): ValidatorMix {
  if (!str) return {};
  const mix: ValidatorMix = {};

  for (const part of str.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) {
      console.error(`Invalid --mix format: "${part}". Expected "name=fraction" or "name=fraction:jitter".`);
      process.exit(1);
    }
    const name = part.slice(0, eqIdx).trim();
    const valueStr = part.slice(eqIdx + 1).trim();

    const colonIdx = valueStr.indexOf(":");
    if (colonIdx === -1) {
      // Plain fraction
      mix[name] = parseFloat(valueStr);
    } else {
      const fracStr = valueStr.slice(0, colonIdx);
      const jitterStr = valueStr.slice(colonIdx + 1);
      const fraction = fracStr ? parseFloat(fracStr) : 0;
      const jitter = parseFloat(jitterStr);
      if (isNaN(jitter)) {
        console.error(`Invalid jitter in --mix: "${part}".`);
        process.exit(1);
      }
      mix[name] = { fraction, jitter };
    }
  }

  return mix;
}

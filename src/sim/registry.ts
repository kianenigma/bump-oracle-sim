import { HonestValidator, type ValidatorConstructor } from "./validator.js";
import {
  MaliciousValidator,
  PushyMaliciousValidator,
  NoopValidator,
  DelayedValidator,
  DriftValidator,
  MaximallyPushyValidator,
} from "./malicious.js";
import type { ValidatorType } from "../types.js";

/** The single source of truth mapping validator-type strings to their
 *  constructor classes. Each class declares its own `compatibleEngines`,
 *  so engine-compatibility checks read directly off the constructor.
 *
 *  Lives in its own module to break the `validators.ts` ↔ `engine.ts`
 *  cycle. */
export const VALIDATOR_REGISTRY: Record<ValidatorType, ValidatorConstructor> = {
  honest:      HonestValidator,
  malicious:   MaliciousValidator,
  pushy:       PushyMaliciousValidator,
  "pushy-max": MaximallyPushyValidator,
  noop:        NoopValidator,
  delayed:     DelayedValidator,
  drift:       DriftValidator,
};

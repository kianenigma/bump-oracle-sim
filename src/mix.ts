// DEPRECATED — replaced by ./validators.ts in the validator-group refactor.
//
// The old ValidatorMix / mix-builder API was a fraction-keyed record
// (`{ malicious: 0.2 }`); the new SimulationConfig uses an explicit
// ValidatorGroup[] array (see ../types.ts). All callers have been migrated
// to ../validators.ts.
//
// This file intentionally has no exports. It is kept as a placeholder until
// the user approves its deletion (see project memory: NEVER delete files
// without explicit user permission).
export {};

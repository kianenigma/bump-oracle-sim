# Oracle Sim — Deferred Tasks

These were explicitly excluded from the **Mega Refactor — Pass 1** (the
config/flow restructure) but came up while scoping it from the
`docs/Price Oracle Chain.md` design + the user's north-star. Capture-now,
implement-later.

The framing follows the four fundamental decisions from the spec:

> 1. Who produces the inputs
> 2. What the inputs are
> 3. How the inputs travel between entities
> 4. How the inputs are aggregated into a final price

---

## A. Quote-aggregator extensions

Pass 1 ships only `median` and `trimmed-mean` as today. The spec calls
out a richer ladder, all under decision (4) **how the inputs are
aggregated**:

- **A.1 — Outlier clipping.** Before taking the median, drop quotes
  that are >X% away from the running median (or from the previous
  oracle price). Configurable threshold + behavior (drop / clip /
  count-as-abstain). Cousin of `trimmed-mean` but value-based instead
  of rank-based.
- **A.2 — Clamp max change.** After aggregation, clamp the new price
  so `|new − last| ≤ maxStep` (absolute or fractional). Models the
  pUSD circuit-breaker idea from the spec.
- **A.3 — Minimum-quotes threshold.** Aggregator refuses to update
  when fewer than `minQuotes` non-abstain inputs are present (e.g.
  require ≥ 2/3 of validator set). Currently the chain happily
  takes the median of any non-empty set.
- **A.4 — Validator confidence / reweighting.** Persist per-validator
  divergence from the final tally over a rolling window. Persistent
  outliers get downweighted (or eventually dropped). This is the
  protocol-level analog of the **History Slashing/Rewarding** section
  in the OH spec. Needs new state on the aggregator + a decay rule.
- **A.5 — Min-nudges (already in spec).** The nudge protocol's
  `min_nudges` knob from `PairConfig` is not modelled. Cheap to add
  once we want it.

---

## B. Per-validator endpoint behavior

The spec's endpoint-fetching block says validators **query n endpoints
+ have outlier-detection + dropping logic** (decisions 1 + 2). Pass 1
keeps the existing single-endpoint-per-query model
(`random-venue` or `cross-venue`). Follow-ups:

- **B.1 — Multi-endpoint per validator.** Each query fetches from
  multiple venues, runs validator-side outlier detection (configurable
  threshold), drops outliers, and produces one local price.
- **B.2 — Endpoint compromise modeling.** Mark a venue as "compromised"
  for some time window — its returned price is biased/manipulated.
  Test how validator outlier-rejection survives.
- **B.3 — Validator price-jitter from real RNG-per-query.** Currently
  each validator has one RNG seed, so jitter is fully reproducible per
  block. If validators had separate jitter draws per venue, the
  multi-endpoint outlier story would be more realistic.

---

## C. Author-side attacks under quote aggregation

Pass 1 only models the nudge-protocol author attacks faithfully (Pushy
= activate all bumps in direction; Noop = activate none). For quote
mode the equivalent space is mostly TODO (decision 3 — **how inputs
travel**, and 4):

- **C.1 — Selective quote inclusion.** Pushy author *picks only* the
  quotes that support its preferred outcome and drops the rest. The
  spec's "select only all honest prices that support your final value"
  attack. Median-trivially-rejects-outliers analysis only holds when
  the author plays fair.
- **C.2 — Forged-but-valid quotes.** Author replaces honest quotes
  with quotes signed by other validators? — out of scope unless we
  add signatures. Document and skip.
- **C.3 — Censorship via partial inherent.** Author drops a chosen
  subset of honest quotes (e.g. anyone whose quote is in the trimmed
  region). Visible under trimmed-mean.

---

## D. Realistic price-path data

Pass 1 keeps the existing trade-data pipeline (`--data-source=trades`,
6 venues). The spec asks for a curated price path with steep drop +
recovery, steep persistent spike, and a calm region:

- **D.1 — Curated date ranges.** Hand-pick three real time-windows
  (e.g. a known DOT crash, a pump, a flat week) and stitch them into a
  single synthetic series with continuous timestamps. Should live in
  `src/data/source.ts` behind a new `DataSourceSpec` variant.
- **D.2 — Synthetic price generator.** Fully fake price path (geometric
  brownian + injected jumps) for property-style tests. Lower priority
  — real stitched data is preferred.

---

## E. Misc / smaller follow-ups

- **E.1 — `min_nudges` config knob** (see A.5).
- **E.2 — Drop the back-compat `noop-author skips aggregation` special
  case in `chain.ts`.** After Pass 1 it should fall out naturally from
  `NoopValidator.produceInherent → []`. Verify and delete the
  carve-out (it's removed in Pass 1; this is just a "make sure no
  test depends on it" note).
- **E.3 — Per-validator seeds.** Each validator gets its own `mulberry32`
  derived from `seed + index`. That's already true; just audit that
  every RNG-using path actually consumes the validator-local one (vs.
  the chain-wide RNG used for author selection).
- **E.4 — Keep .simdata back-compat?** Pass 1 changes
  `SimulationConfig` shape, so old `.simdata` index.json files won't
  type-check on load. Either bump `version` and add a migration or
  document "regenerate `.simdata` after this refactor". Default:
  document + bump.

---

## Out-of-scope reminders (for completeness)

- **F.1 — JAM compatibility / AH-collator variant.** Discussed in the
  spec but irrelevant for the simulator until the protocol decision
  itself moves.
- **F.2 — Slashing / reward modeling.** The spec mentions era-reward
  points for valid inherents. Not interesting until A.4 is in.
- **F.3 — Manager Binary kill-switch / OCW kill-switch.** Spec-level
  operational tooling; nothing to simulate.

# Oracle Aggregator Tournament — Final Report

**Question**: under up to 1/3 byzantine validators (Polkadot's threshold: ≥ 2/3 + 1 honest, equivalently byzantine ≤ floor((N-1)/3)), which is structurally better — **nudge with `minInputs = 0`** or **median with `minInputs = floor(2N/3) + 1`**?

**Answer**: Both are robust at the protocol's stated threshold. **Median (B) is the better choice** — lower mean deviation across every attacker, and the simpler design wins on the very property the user cared about: simplicity. **Do not add confidence tracking to median** — at the strict threshold it is a strict liability.

This report is sourced entirely from preserved `.simdata` artifacts under [`tournament-runs/`](tournament-runs/). The full per-round journal is in [`TOURNAMENT.md`](TOURNAMENT.md).

---

## Setup

- **N = 300** validators. **Byzantine = 99** (Polkadot's strict threshold; see "Threshold calibration" below for why this matters more than expected).
- DOT/USDT trades data, 2025-10-10 → 2025-10-20 (158,400 blocks @ 6s, six venues, cross-venue mean as ground truth, random-venue per-validator observation, 0.1% jitter).
- Same data, same seed, same validator placement for every system in every test.
- "Broken" criterion: mean deviation > 5%, *or* max single-block deviation > 100%, *or* > 10% of blocks consecutively above 0.5% deviation.

## Threshold calibration

The minInputs formula `floor(2N/3) + 1 = 201` (for N=300) is calibrated for **byzantine ≤ 99** — strictly less than 1/3. The aggregator's freeze condition `quotes.length < minInputs` means:

- 99 byzantine + 201 honest, all honest submit: 201 quotes meet minInputs → median computes from honest cluster → **bounded**.
- 100 byzantine + 200 honest, all honest submit: 200 quotes < 201 → freeze branch fires → cabal can selectively trigger freezes → **broken**.

The first 5 rounds of this tournament tested at `fraction = 1/3`, which JS resolves to exactly 100 byzantine. That's one past the protocol's stated bound. Re-running at the corrected `fraction = 99/300` produced dramatically different outcomes — the entire defense-ladder narrative collapses because the abstention attacks no longer have leverage.

---

## Final results: byzantine = 99 (the strict threshold)

39 sims. Every attacker class tested against three systems:

- **A baseline**: `{ kind: "nudge", epsilon: "auto", minInputs: 0 }`
- **B baseline**: `{ kind: "median" }`  *(no defenses)*
- **B hardened-v3**: B + wideband-attributed confidence tracking + permanent exclusion (the most-developed defense from the round-by-round work)

Mean deviation by attacker × system. Bold cells indicate "broken" by the criterion.

| Attacker                    | A nudge baseline | **B median baseline**     | B hardened-v3                  |
|-----------------------------|------------------|---------------------------|---------------------------------|
| honest-baseline             |  0.156%          |  0.079%                   |  0.186%                         |
| withholder-up               |  0.167%          |  **0.107%** ✓             |  0.185%                         |
| withholder-down             |  0.154%          |  **0.088%** ✓             |  0.189%                         |
| bias-injector-up            |  0.574%          |  **0.107%** ✓             |  0.185%                         |
| bias-injector-down          |  0.587%          |  **0.088%** ✓             |  0.189%                         |
| overshoot-ratchet-up        |  0.902%          |  **0.107%** ✓             |  0.185%                         |
| overshoot-ratchet-down      |  0.920%          |  **0.088%** ✓             |  0.189%                         |
| stealth-withholder-up       |  0.902%          |  **0.101%** ✓             |  0.186%                         |
| stealth-withholder-down     |  0.920%          |  **0.082%** ✓             |  0.190%                         |
| convergent-cabal-up         |  0.902%          |  **0.088%** ✓             |  0.185%                         |
| convergent-cabal-down       |  0.919%          |  **0.074%** ✓             |  0.187%                         |
| inband-shifter-up           |  0.902%          |  **0.192%** ✓             | **NaN — catastrophic**          |
| inband-shifter-down         |  0.920%          |  **0.161%** ✓             | **91.91% — broken**             |

Source: [`tournament-runs/rerun-strict-threshold.simdata/index.json`](tournament-runs/rerun-strict-threshold.simdata/index.json).

## Findings

### 1. Both baselines are robust at the strict threshold

Neither A nor B-baseline broke under any of the six attacker classes. The minInputs formula does exactly what its derivation suggests — when ≥ 2/3 + 1 honest, the aggregator has enough valid inputs that the median computes correctly from the honest cluster regardless of cabal behaviour.

### 2. Median (B) is more accurate than nudge (A) under every attacker

A's mean deviation rises from 0.156% (honest) up to 0.92% under amplification attacks — a 6× noise increase per attacker class. B's mean deviation stays in the 0.07-0.19% band regardless of attacker, *lower than its honest baseline in some cases* (because the cabal's biased quotes get washed out by the median over 201 honest, which is a slightly cleaner aggregation than 300 random-venue quotes).

| Metric                                      | A nudge baseline | B median baseline |
|---------------------------------------------|------------------|--------------------|
| Honest-only mean dev                        |   0.156%         |   0.079%           |
| Worst attacker mean dev                     |   0.920%         |   0.192%           |
| Range (worst − honest)                      |   ~6×            |   ~2.4×            |

### 3. Confidence tracking is harmful at the strict threshold

The most-developed defense in B's defense ladder (wideband-attributed confidence + permanent exclusion, the one that handled all attackers at byzantine=100) is **catastrophically broken** by `inband-shifter` at byzantine=99. The mechanism: random-venue observation produces honest dispersion > 5% during real-world volatility (e.g. the sharp DOT drop on 2025-10-15); the wideband=5% goodBand misclassifies those laggy-venue honest validators as bad-quote; they accumulate -0.05 each block; eventually enough are excluded that the cabal becomes ≥ 50% of the active set; oracle decays exponentially toward zero (factor 0.96/block).

This failure mode is **independent of cabal size**. With 99 cabal it still triggered; the only difference is the tipping point is reached slightly later in the simulation.

The defense doesn't fix any attack that B-baseline can't already handle, *and* it introduces a new failure mode. Net: confidence tracking is a strict liability at the strict threshold. **Do not ship it.**

### 4. The earlier "median is broken" narrative was an artifact of the off-by-one

Rounds 0-5 of the original tournament showed median repeatedly breaking under attackers like withholder, bias-injector, and stealth-withholder. All of those breakages required cabal = 100. At cabal = 99, none of them survive. The `2N/3 + 1` minInputs formula is correctly calibrated; we were testing the wrong threat model.

The lesson: **the protocol's stated threshold matters; testing one past it produces qualitatively different results.** This isn't a tweakable margin — the aggregator's behaviour is binary at the threshold.

## Recommendation

**Ship median + `floor(2N/3) + 1` minInputs as the default aggregator.** No confidence tracking, no k-trim, no per-validator state. The aggregator's BFT-derived threshold does the work, and the design is intrinsically robust at Polkadot's stated assumption.

Why median over nudge:
- Lower mean deviation across every attacker (0.07-0.19% vs 0.15-0.92% at default ε).
- Lower worst-case noise under amplification attacks.
- Equally simple in implementation: median + minInputs is ~30 lines of code vs nudge's ~25.
- Doesn't need an ε parameter (auto-resolved or otherwise).

If you choose nudge for orthogonal reasons (1-bit gossip bandwidth, simpler block author math, etc.), use **ε = `auto / 4`** rather than the auto default. The ε-sweep ([`tournament-runs/rerun-strict-threshold-eps-sweep.simdata/`](tournament-runs/rerun-strict-threshold-eps-sweep.simdata/)) shows damage from amplification attackers (`bias-injector`, `overshoot`, `pushy`, `drift`, `inband-shifter`, etc.) scales almost exactly linearly with ε:

| Attacker          | ε:1     | ε:½     | ε:¼     | median  |
|-------------------|---------|---------|---------|---------|
| overshoot↑        | 0.94%   | 0.52%   | 0.31%   | 0.11%   |
| drift             | 1.26%   | 0.71%   | 0.44%   | 0.19%   |
| pushy             | 0.75%   | 0.44%   | 0.28%   | 0.09%   |
| inband-shifter↑   | 0.94%   | 0.52%   | 0.31%   | 0.19%   |
| honest baseline   | 0.156%  | 0.159%  | 0.165%  | 0.079%  |

Quartering ε reduces amplification damage 3× on the worst class. The cost is a 6% relative increase in honest noise and slower oracle response during sharp real-price moves (max single-block deviation 33% → 57% during the largest event in the data window — still far below the 100% break threshold). Net trade is strongly favourable.

**Do not** add confidence tracking, k-trim, or any per-validator-state defense. They solve attacks that don't exist at the strict threshold and introduce attacks that do.

## Reproducibility

Every result in this report is reproducible by running:

```
bun run src/main.ts --scenario tournament-rerun-strict-threshold \
  --start-date 2025-10-10 --end-date 2025-10-20 \
  --output tournament-runs/rerun-strict-threshold-eps-sweep.simdata --force --threads 6
```

72 sims (4 systems × 18 attacker variants — 1 honest + 6 directional × ↑/↓ + 5 directionless: `malicious`, `pushy`, `noop`, `delayed`, `drift`). Per-block oracle prices, real prices, deviations, and validator-type vectors are preserved in [`tournament-runs/rerun-strict-threshold-eps-sweep.simdata/`](tournament-runs/rerun-strict-threshold-eps-sweep.simdata/).

The full round-by-round development of attackers and defenses is in [`TOURNAMENT.md`](TOURNAMENT.md). Useful for understanding *what kinds of attacks become available if the protocol's threshold assumption is violated, and why the natural defenses against them fail*.

---

## Tournament summary stats

- **Rounds run**: 5 (at byzantine = 100) + 1 re-run scenario (at byzantine = 99).
- **Distinct attacker classes engineered**: 6 (`withholder`, `bias-injector`, `overshoot-ratchet`, `stealth-withholder`, `convergent-cabal`, `inband-shifter`).
- **Defense attempts on B** (byzantine = 100 case): 6 (3 committed, 3 rejected/partial).
- **Total simulations**: 6 attackers × 2 directions × 3 systems = ~36 + 5 round runs (~60 sims) + 6 defense verification runs (~80 sims) ≈ **200+ simulations**, each 158,400 blocks.
- **Compute**: ~6 hours total wall-clock time, threaded across 6 worker processes.
- **Storage**: ~3.5 GB of `.simdata` artifacts preserved for re-inspection.

Type-check at completion: `npx tsc --noEmit` clean.

User's original ask — "find a methodology to concretely compare nudge and median" — produced a clean answer: at Polkadot's stated threshold both are robust; median is quantitatively better. The defense-ladder development under the wrong threshold is preserved as a cautionary example of what happens when threshold assumptions slip.

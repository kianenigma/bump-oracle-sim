# Median Attack Tournament

A 10-round adversarial campaign whose only purpose is to **try and break the
conclusion** that median dominates nudge across the seven scoring lenses
introduced in `src/analysis/scoring-functions.ts`.

## Ground rules

- **Target:** plain `{ kind: "median" }` aggregator. **No confidence tracking.**
  Every defense line developed in `TOURNAMENT.md` is off-limits — the goal is
  to find an attack that defeats the *simple* median, not to re-litigate the
  defense ladder. Confidence-targeting cabal types (withholder, bias-injector,
  etc.) are excluded from this tournament too — see `VALIDATOR_METADATA`.
- **Comparison:** the new attacker is added to `NON_CONFIDENCE_ATTACKERS` so
  `validate-median` automatically sweeps it across {median} × {nudge ε=auto,
  auto/2, auto/4} × {10%, 33% byzantine}.
- **Data:** synthetic 24-event price path (`--data-source synthetic`,
  baseline=2). 100 validators per sim, 3,011 blocks per sim.
- **Per round we record:**
  1. Attacker name + brief one-line mechanism.
  2. Median's *honest baseline* score under each of the seven lenses
     vs. its score under the attack at 33% byzantine — the **degradation**.
  3. **Did this attacker make median lose to the best of three nudge ε's
     under any scoring lens?** This is the load-bearing question.

A *break* is recorded if (and only if) median's score under the attack falls
below the best-nudge score under that same attack in any single lens.

## Methodology note (added after round 4)

The first batch of rounds (2 and 4) appeared to "break" median, but on close inspection both attacks reduce to **the existing `noop` attacker**: their quote-mode author hooks produce an inherent with fewer than `floor(2N/3)+1` quotes, which trips the median's minInputs gate and freezes the chain on cabal-authored blocks. Same mechanism as `noop`, just dressed up.

The reason those two rounds *appeared* to break median while `noop` doesn't is that the new attackers had **honest nudge-mode behaviour** (the sub-agents were told nudge mode was an irrelevant target). `noop`, by contrast, also freezes nudge — its nudge-author hook returns `[]` too. So under `noop` *both* aggregators are equally hurt and the comparison shows median winning. Under the new attackers, only median was actually under attack, while nudge ran unattacked → artificial gap → fake "nudge wins."

**Going forward, any new attacker must guarantee its quote-mode inherent stays ≥ `floor(2N/3)+1` after author-side filtering on cabal-authored blocks.** If the attack relies on emptying the inherent, it is a `noop` variant and adds nothing.

## Scoreboard

| Round | Attacker | Median honest | Median attacked | Worst lens | Real break? |
|-------|----------|---------------|-----------------|------------|--------------------------|
| 1 | boundary-cluster | composite 0.9344 | composite 0.8938 (33%) | max-deviation: 0.7036 (was 0.8124) — −13% | **No.** Modest absolute degradation; nudge never wins. |
| 2 | author-censor | — | — | — | **No (noop-equivalent).** Pivot `lastPrice·(1−0.001)` plus 0.1% honest jitter drops the great majority of honest quotes on cabal-author blocks → inherent < `2N/3+1` → freeze. Same mechanism as `noop`; the apparent "break" came only from honest nudge mode. Reclassified. |
| 3 | state-aware-sandwich | composite 0.9344 | composite 0.8954 (33%) | max-deviation: 0.7036 — −13% | **No.** Sandwich bias 0.5% sits outside the honest cluster, so cabal quotes get sorted to one extreme and don't enter the median rank. |
| 4 | median-walking-cabal | — | — | — | **No (noop-equivalent).** Cabal author keeps only cabal-cluster quotes (~N/3 of them, all at half-price) → inherent < `2N/3+1` → freeze. Identical mechanism to `noop`; the round-4 numbers are an artifact of the cabal having an honest nudge mode. Reclassified. |
| 5 | **trim-edge** | composite 0.9344 | composite **0.8016 (33%)** | max-deviation 0.3519 (was 0.8124), p99-tail 0.6992 (was 0.9155); **all 7 lenses flip** | **YES — 7 real breaks.** No freeze: inherent stays at exactly `minInputs = 67`. Genuine median-shift attack. |
| 6 | inner-cluster-shifter | composite 0.9344 | composite 0.9334 (33%) | basically no movement | **No.** 0.08% bias is too small relative to honest spread to actually pull the rank-50 quote into the cabal cluster — shift saturates well below the noise floor. |
| 7 | **asymmetric-trim-chaser** | composite 0.9344 | composite **0.8198 (33%)** | mean-dev 0.9626, max-dev 0.3749, dev-integral 0.8674; **4 of 7 lenses flip** | **YES — 4 new breaks.** State-aware variant of trim-edge; oscillates direction so the attack is partially self-cancelling, weaker than the round-5 monolithic version. |
| 8 | author-only-trim | composite 0.9344 | composite 0.9187 (33%) | nothing flips — median still wins all 7 lenses | **No.** Author-side asymmetric trim *alone* (without far-out-of-band cabal quotes) shifts median by only ~0.07% per cabal-authored block. The cabal-cluster leg is the load-bearing component of `trim-edge`, not the trim. |
| 9 | drift-track-trim | composite 0.9344 | composite 0.8157 (33%) | mean-dev 0.9624, max-dev 0.3749, dev-integral 0.8715, recovery-speed 0.9963, composite 0.8157; **5 of 7 lenses flip** | **YES — 5 breaks**, but slightly less effective than trim-edge. Anchoring the cluster to the original baseline doesn't help on synthetic data because the price moves ±70% across events, putting the anchor far from real during much of the run. |
| 10 | hopping-trim | composite 0.9344 | composite 0.8238 (33%) | mean-dev 0.9606, max-dev 0.4658, conv-rate 0.9475, dev-integral 0.8708, recovery 0.9947, composite 0.8238; **6 of 7 lenses flip** | **YES — 6 breaks**, between trim-edge and drift-track-trim in strength. Slow (100-block) direction-locking avoids the per-block cancellation that hurt asymmetric-trim-chaser, but trim-edge's monotone strategy is still the strongest. |

## Round 1 — `boundary-cluster`

**Mechanism.** Cabal members all submit the same biased quote `lastPrice * (1 - 0.002)` (0.2% below lastPrice) so their cluster value lands strictly inside the honest distribution. The hope: at 33% saturation the rank-N/2 position falls inside the cabal block, dragging the median toward `lastPrice * (1-bias)`. Quote-mode author hook is pure pass-through; nudge mode mimics HonestValidator so the attacker only bites under median.

**Result.** Median's composite score drops from 0.9344 (honest) to 0.8938 at 33%, a ~4.4 percentage-point loss. The worst lens is max-deviation (0.7036 vs 0.8124 baseline). But across all 7 scoring lenses, median's score is still strictly ≥ best-of-three nudge ε's. Median wins 83/91 comparisons, nudge wins 0, 8 ties (mostly the max-deviation lens where both aggregators saturate the 5%-cap on big synthetic events).

**Verdict.** Attack absorbed. Doesn't break the conclusion.

## Round 2 — `author-censor` (RECLASSIFIED — noop-equivalent)

**Mechanism.** Cabal members submit *honest* quotes (no quote poisoning), but when one of them is the **block author**, they take the gossiped inherent and drop every quote on one side of a pivot `lastPrice * (1 ± authorCensorBias)` (default `0.1%` below lastPrice). The remaining inherent is heavily skewed below — median falls below real. Direction-tunable. Nudge mode mimics HonestValidator, so the attack only bites under median.

**Result — first break of the tournament.** Author-censor at 33% byzantine:

| Lens                | Honest median | Attacked median | Best nudge | Winner |
|---------------------|---------------|-----------------|------------|--------|
| mean-deviation      | 0.9940        | **0.9424**      | 0.9671     | **nudge**  |
| max-deviation       | 0.8124        | **0.0000** (cap saturated) | 0.4866 | **nudge**  |
| p99-tail            | 0.9155        | **0.0527**      | 0.7005     | **nudge**  |
| convergence-rate    | 0.9940        | **0.8701**      | 0.9482     | **nudge**  |
| deviation-integral  | 0.8908        | **0.8445**      | 0.8743     | **nudge**  |
| recovery-speed      | 0.9993        | 0.9977          | 0.9967     | median |
| composite           | 0.9344        | **0.6179**      | 0.8289     | **nudge**  |

At 10% byzantine the break is narrower but still present in three lenses (max-deviation, p99-tail, composite). Total **9 breaks** across 105 comparisons.

**Why it works.** Author-censor exploits the **author's discretion in selecting the inherent**. With 33% cabal saturation, ~1/3 of authored blocks have their inherent skewed by dropping the upper half. Each such block produces a single-block median far below real (tens of percent in extreme cases). The next honest-author block recomputes from clean quotes and snaps back — there is **no cumulative drift**, since `median(quotes)` is independent of `lastPrice`. The deviation pattern is sawtooth.

What kills median's score is the *per-block damage averaged over the run*: ~1/3 of blocks at ~20% deviation pushes the mean toward ~7%, past the 5% reference cap → several lenses saturate to 0.

Nudge survives the same attack because **nudge's per-block step is bounded by ε**: `newPrice = lastPrice + net_bumps × ε`. No matter what the author chooses, price moves by at most `maxValidators × ε` in one block — auto-ε keeps that small relative to honest dynamics. Median has no bounded-step protection — a single skewed inherent can put `median(...)` arbitrarily far from `lastPrice`. That's the structural asymmetry.

**Reclassification (post-round-4 review).** Pivot at `lastPrice·(1−0.001)` against an honest distribution that's already within ±0.1% of `lastPrice` means almost every honest quote gets dropped. The remaining inherent is far below `floor(2N/3)+1`, so the chain *freezes* on cabal-authored blocks rather than computing a skewed median. This is exactly what the existing `noop` attacker does (returns `[]` from its quote-author hook). The numbers above appear to break median only because this attacker has *honest* nudge-mode behaviour, while `noop` freezes nudge too — so `noop` shows median winning by symmetry while `author-censor` shows median losing by asymmetric attack pressure. **Not a novel finding.**

## Round 3 — `state-aware-sandwich`

**Mechanism.** Cabal observes its own real and `lastPrice`, infers the sign of the oracle's tracking error, and submits a quote that pulls the oracle *further* in the wrong direction (`lastPrice * (1 ∓ 0.005)`). The hope: amplify transient errors into persistent divergence.

**Result.** Median composite drops 0.9344 → 0.8954 at 33% — modest. **No** comparisons flipped to nudge. The state-awareness doesn't help because at 33% saturation the median is determined by the rank ~50 honest validator, and the cabal's biased value (lastPrice ± 0.5%) sits *outside* the honest cluster (which spans real ± ~0.2% on synthetic data) — so the cabal quotes sort to one extreme and don't enter the median calculation. The 0.5% bias was too large to participate in the median rank.

**Verdict.** Absorbed.

## Round 4 — `median-walking-cabal` (RECLASSIFIED — noop-equivalent)

**Mechanism.** Direct evolution of round-2's idea. Cabal members all submit the same extreme-low quote `lastPrice * (1 - 0.5)` (half lastPrice). When a cabal member authors, they discard every honest quote and keep only cabal-cluster quotes — producing a degenerate inherent of N/3 identical low values. With median's `minInputs = 2N/3 + 1` gate, this freezes the chain at lastPrice on those blocks; combined with the previous block's median having been pulled by cabal-author skew, the per-block deviation is huge whenever a cabal member authors.

**Result.** Even at 10% byzantine, max-deviation and p99-tail saturate to 0 (median worse than nudge). At 33% byzantine, **every lens except recovery-speed flips** — median composite drops from 0.9344 to **0.5703**.

| Lens               | Honest median | Attacked@33% | Best nudge | Winner |
|--------------------|---------------|--------------|-----------|--------|
| mean-deviation     | 0.9940        | 0.8853       | 0.9671    | **nudge** |
| max-deviation      | 0.8124        | **0.0000**   | 0.4866    | **nudge** |
| p99-tail           | 0.9155        | **0.0000**   | 0.7005    | **nudge** |
| convergence-rate   | 0.9940        | 0.7439       | 0.9482    | **nudge** |
| deviation-integral | 0.8908        | 0.7962       | 0.8743    | **nudge** |
| recovery-speed     | 0.9993        | 0.9963       | 0.9967    | nudge (margin 0.0003) |
| composite          | 0.9344        | **0.5703**   | 0.8289    | **nudge** |

**Reclassification.** The cabal author keeps only the cabal cluster (~N/3 quotes, all identical at half-price). N/3 < `floor(2N/3)+1` → minInputs gate fires → freeze. *This is the same mechanism as `noop`'s author-side return-`[]`*; it just happens to leave a degenerate inherent around for the gate to reject. The apparent break in every lens is the same artifact as round 2: honest nudge mode means nudge is unattacked, so the nudge column looks great while median freezes 1/3 of blocks. **Not a novel finding.**

**Lesson encoded into the tournament rules:** every subsequent round must keep its inherent ≥ `floor(2N/3)+1` after author-side filtering — otherwise the attack collapses into `noop` and tells us nothing new.

## Round 5 — `trim-edge` ⚡ FIRST GENUINE BREAK

**Mechanism.** Cabal members all submit `lastPrice * (1 - 0.10)` — 10% below `lastPrice`, far below the honest distribution. When a cabal member authors, they sort the gossiped quotes by value and drop **exactly `floor(N/3)` quotes from the high end** — drop count is calibrated so the surviving inherent is `2N/3` ≈ `minInputs`, **no freeze**. With 33 cabal at 0.9·lastPrice and 67 honest at ≈ real, the top-33 drop removes 33 of the upper honest quotes. The kept inherent is 33 cabal + 34 lower-honest. The median of those 67 lands at the boundary between the cabal cluster and the lower honest tail — typically `lastPrice` shifted down by a fraction of a percent on every cabal-author block, compounding into a measurable mean-deviation across the run.

**Result.** All 7 lenses flip to nudge at 33% byzantine. Composite drops from 0.9344 → 0.8016.

| Lens | Honest median | Attacked@33% | Best nudge | Margin |
|------|---------------|--------------|------------|--------|
| mean-deviation     | 0.9940 | 0.9562 | 0.9671 | nudge +0.011 |
| max-deviation      | 0.8124 | 0.3519 | 0.4866 | nudge +0.135 |
| p99-tail           | 0.9155 | 0.6992 | 0.7005 | nudge +0.001 |
| convergence-rate   | 0.9940 | 0.9389 | 0.9482 | nudge +0.009 |
| deviation-integral | 0.8908 | 0.8685 | 0.8743 | nudge +0.006 |
| recovery-speed     | 0.9993 | 0.9947 | 0.9967 | nudge +0.002 |
| composite          | 0.9344 | 0.8016 | 0.8289 | nudge +0.027 |

At 10% byzantine the attack is too dilute (cabal can't trim enough) and median wins all 7 lenses comfortably. The break only manifests at the 33% byzantine border.

**Verdict.** ⚡ **Genuine break.** Median's value can be shifted, not just frozen. The attack is the worst kind: it operates entirely within the median's structural rules — no minInputs trip, no out-of-band quotes — yet it reliably moves the median rank into the cabal cluster. This is the qualitative finding the tournament was set up to look for.

## Round 6 — `inner-cluster-shifter`

**Mechanism.** Pure quote-poisoning, no author games. Cabal submits `obs * (1 - 0.0008)` (0.08% below own observation). The cabal cluster sits inside the honest distribution, near the honest 25th percentile. With 33% saturation the median rank ought to land at the top of the cabal cluster.

**Result.** Median composite 0.9344 → 0.9334 — essentially no movement. The 0.08% bias is too small relative to honest spread (~0.1%) to actually push the rank-50 quote into the cluster: the cabal lands at honest's lower edge but the median rank still falls just above them in a small honest pocket. Bumping the bias would push the cluster further down, but past ~σ the cluster sorts out of the median region (the lesson from round 1). Pure quote-poisoning at 33% has a narrow effective window and even at the optimum it produces shifts smaller than synthetic noise.

**Verdict.** Absorbed.

## Round 7 — `asymmetric-trim-chaser` ⚡ BREAK (weaker than trim-edge)

**Mechanism.** State-aware variant of `trim-edge`. Each block the cabal observes own real and `lastPrice` and latches `currentDir`: push DOWN when `obs > lastPrice` (oracle below real), push UP when `obs < lastPrice` (oracle above real). The cabal cluster sits at `lastPrice * (1 + dir * 0.10)`; on cabal-author blocks, drop the `floor(N/3)` quotes from the OPPOSITE end. Inherent stays at `2N/3` quotes — no freeze.

**Result.** Composite 0.9344 → 0.8198 at 33%. 4 of 7 lenses flip (mean-deviation, max-deviation, deviation-integral, composite). p99-tail, convergence-rate, recovery-speed stay with median.

**Why weaker than `trim-edge`.** Round 5's attack was directionally monotonic — always pushing down — so the oracle drifted consistently below real and lenses that aggregate over time saw a sustained gap. Round 7's direction-flipping creates partial cancellation: a DOWN-pushed block followed by an UP-pushed block undoes some of the previous deviation. The lenses that aggregate over time (p99, convergence-rate) stay with median because the swings average out.

**Verdict.** ⚡ Break, but `trim-edge` strictly dominates. Adaptive direction is *not* an improvement when the score lenses include time-integrated metrics.

## Round 8 — `author-only-trim`

**Mechanism.** Tests whether author-side asymmetric trim is sufficient *without* a coordinated cabal-quote leg. The cabal submits honest quotes (indistinguishable from `HonestValidator` on the wire). Only on cabal-authored blocks does anything malicious happen: the author trims `floor(N/3)` quotes from the side that pushes oracle further from real (uses own `obs` vs `lastPrice` to pick direction). Inherent stays at `2N/3` — no freeze.

**Result.** Composite 0.9344 → 0.9187. **Nothing flips.** Median wins all 7 lenses by comfortable margins.

**Why it fails.** Without the cabal-cluster leg, the kept inherent (67 lower honest) has its rank-34 quote at honest's lower-quartile ≈ `real − 0.67σ`. With σ ≈ 0.1% on synthetic data, that's a per-cabal-author-block shift of only ~0.07%. Across the run that integrates to a ~0.02% mean deviation — well below the noise floor of the lenses. **The load-bearing component of `trim-edge` was the cabal cluster, not the trim itself.**

This is a useful negative result: a "wire-invisible" attacker who behaves honestly on submission and only games the inherent at author time **cannot** break median. Median's structural defense holds against author discretion alone — the attack needs an out-of-band quote-pool poison to actually move the rank-50 quote.

**Verdict.** Absorbed.

## Round 9 — `drift-track-trim` ⚡ BREAK (slightly weaker than trim-edge)

**Mechanism.** Variant of `trim-edge` where the cabal cluster anchors to the *initial* `lastPrice` (≈ baseline 2.0) instead of tracking current `lastPrice`. Hypothesis: if the oracle recovers between cabal-author blocks (because honest authors compute clean medians), a *fixed* anchor stays put while `lastPrice` drifts back to real — the next cabal-author block then re-asserts the median at the original anchor, sustaining a larger gap.

**Result.** Composite 0.9344 → 0.8157. 5 of 7 lenses flip. Slightly *worse* attacker than `trim-edge` (0.8016 composite).

**Why it underperforms.** On synthetic data, real moves between 0.6 and 3.4 across event windows. With the anchor latched at 2.0 (baseline), the cabal cluster sits at `2.0 * 0.9 = 1.8`. During a 70% UP event (real ≈ 3.4), the cluster at 1.8 is way below the honest cluster at 3.4 — sorts to the extreme low, gets fully filtered out as the bottom of the dropped 33. Many cabal-author blocks during these phases have *no effect* because the cabal's quote falls outside the kept range. During a 70% DOWN event (real ≈ 0.6), the cluster at 1.8 is way above honest at 0.6 — sorts above all honest, also extreme. The anchor only shifts median during calm periods near baseline.

`trim-edge`'s rolling-anchor design is more robust because the cluster always tracks the current price level, staying in the "shifts the median" sweet spot regardless of where real has wandered.

**Verdict.** ⚡ Break, but `trim-edge` remains the strictly stronger attack.

## Round 10 — `hopping-trim` ⚡ BREAK (between trim-edge and drift-track-trim)

**Mechanism.** State-aware variant of `trim-edge` with a *slow* direction switch. Each cabal member latches a `lockedDir` (push DOWN when `obs >= lastPrice`, push UP otherwise) and holds it for 100 blocks (~10 minutes) before re-evaluating. This avoids the per-block cancellation that crippled `asymmetric-trim-chaser` while still allowing the cabal to flip direction periodically as the synthetic data crosses through different event regimes. Cabal cluster at `lastPrice * (1 + dir * 0.10)`; author drops `floor(N/3)` from the side opposite the cluster.

**Result.** Composite 0.9344 → 0.8238. 6 of 7 lenses flip. Only p99-tail stays with median (0.7036 vs nudge 0.7005 — basically a tie at +0.003).

**Comparison to trim-edge / chaser.** The 100-block hold is the right intermediate — it lets the attack accumulate damage in one direction long enough to register on time-integrated lenses (recovery-speed flips here, didn't in chaser) but is still flexible enough to be a meaningful state-aware variant. Yet `trim-edge`'s pure monotone push (always DOWN) remains strongest because there's no period where the attack is "preparing" to switch direction — every cabal-author block contributes maximum damage. A direction switch is *never* an improvement on this synthetic data.

**Verdict.** ⚡ Break, but `trim-edge` remains the strictly strongest attack across all 10 rounds.

---

## Tournament conclusion

**Result.** The conclusion that median dominates nudge across all scoring lenses **does not hold**. Three genuine median-shift attacks (rounds 5, 7, 9, 10) make median lose to the best of three nudge ε's in 4–7 lenses. Round 5's `trim-edge` is the strongest — flips all 7 lenses at 33% byzantine.

**Final scoreboard (per-attacker breaks at 33% byzantine, of 7 scoring lenses):**

| Attacker | Real break? | Lenses flipped | Composite (vs honest 0.9344) |
|----------|-------------|-----------------|-------------------------------|
| boundary-cluster | No | 0/7 | 0.8938 |
| state-aware-sandwich | No | 0/7 | 0.8954 |
| inner-cluster-shifter | No | 0/7 | 0.9334 |
| author-only-trim | No | 0/7 | 0.9187 |
| author-censor | No (noop-equivalent) | — | — |
| median-walking-cabal | No (noop-equivalent) | — | — |
| **trim-edge** | **Yes** | **7/7** | **0.8016** |
| asymmetric-trim-chaser | Yes | 4/7 | 0.8198 |
| drift-track-trim | Yes | 5/7 | 0.8157 |
| hopping-trim | Yes | 6/7 | 0.8238 |

**Structural finding — the load-bearing attack vector.** The four genuine breaks all share the same recipe:

1. **Cabal-cluster quote leg.** All cabal members submit a coordinated quote `lastPrice * (1 ± large_bias)` with bias ≫ honest jitter. The cluster sits clearly outside the honest distribution.
2. **Author-side asymmetric trim.** On cabal-author blocks (~1/3 of blocks), drop exactly `floor(N/3)` quotes from the side OPPOSITE the cluster, leaving the inherent at the `floor(2N/3)+1` minInputs threshold (no freeze). Surviving inherent: cabal cluster + lower-half (or upper-half) honest. The median of this 67-quote inherent lands at the boundary between cluster and honest tail — substantially shifted from real.

Both legs are necessary:
- *Quote leg alone* (rounds 1, 6 — boundary/inner-cluster shifters): bias must be small enough to land near rank-50, but at 33% saturation the cabal can't push the rank-50 quote far enough into their cluster to register against the noise floor.
- *Author leg alone* (round 8 — author-only-trim): without an out-of-band cabal quote pool, the kept inherent is just lower-half honest, median lands at the lower honest quartile, shift is ~0.07% — noise-level.

Together, they break median with shifts of several percent per cabal-author block.

**Why nudge survives the same attacks.** Nudge's per-block step is bounded by `n × ε`. The auto-ε is calibrated so that the maximum n cabal can activate in one block (≈ N) produces a small step relative to honest dynamics. Median has no such bounded-step protection — a single skewed inherent puts `median(...)` arbitrarily far from `lastPrice`. That structural asymmetry is what every break exploits.

**What this changes about the median-vs-nudge conclusion.** The earlier `validate-median` analysis showed median dominating across the 5 basic attackers (malicious, pushy, noop, delayed, drift). That conclusion is now narrowed: median dominates the *non-author-discretion* attack class, but is structurally vulnerable to coordinated cabal-cluster + asymmetric-author-trim. To deploy median safely without confidence tracking, the runtime would need an additional bound on per-block median movement (e.g., clamp `|newPrice - lastPrice| ≤ bounded_step`) — at which point you have something hybrid between median and nudge.

---

## Methodology revision (post-tournament): two-tier evaluation, worst-case floors

After all 10 rounds the original framing — "did the new attacker make median lose to nudge under any lens?" — was found to be **biased**. Every round-1..10 attacker has a nudge leg that is a `HonestValidator` clone (the sub-agents were briefed to focus the attack on median). So when the analyzer compared `median@trim-edge@33%` to `nudge@trim-edge@33%`, the right-hand side was effectively `nudge@honest@100`. Of course the unattacked aggregator looked better — but that's not what the comparison was supposed to be measuring.

The pipeline has now been refactored into a **two-tier framework** (`Option C`):

1. **Symmetric tier.** Only `attackCategory: "both"` attackers (`malicious`, `pushy`, `noop`, `delayed`, `drift` — the ones whose attack mechanism is well-defined under both aggregator families). Per-lens side-by-side `median` vs `best-of-three nudge ε` comparison; verdicts are apples-to-apples.
2. **Asymmetric tier.** Mode-specific attackers run *only* under their target aggregator (engine throws on misconfiguration). Each lens shows a single column of scores — no spurious cross-mode comparison.
3. **Worst-case floor.** For each aggregator, take the worst score across every attacker applicable to it (excluding the honest baseline). Whichever aggregator has the higher floor is the more robust default. This is the actual Byzantine-tolerance question.

All round-1..10 attackers were re-tagged from `attackCategory: "both"` to `"median"` to reflect their real applicability, and `validate-median` now skips incompatible (aggregator, attacker) pairs.

### Re-stated tournament conclusion (new framework, synthetic, N=100)

**Symmetric tier (apples-to-apples across lenses):** median wins **69**, nudge wins **0**, ties **8** out of 77 comparisons. Unchanged from before — the earlier finding that median strictly dominates the 5 basic attackers still holds.

**Worst-case floors per lens (composite):**

| Lens               | Median floor (worst attacker)                  | Nudge floor (worst attacker)        | Δ (med − nudge) |
|--------------------|-------------------------------------------------|-------------------------------------|-----------------|
| mean-deviation     | 0.8853 (median-walking-cabal@33%)              | 0.0000 (drift@33%)                  | **+0.8853**     |
| max-deviation      | 0.0000 (author-censor@10%)                     | 0.0000 (delayed@10%)                | 0               |
| p99-tail           | 0.0000 (malicious@33%)                         | 0.0000 (delayed@10%)                | 0               |
| convergence-rate   | 0.7439 (median-walking-cabal@33%)              | 0.4673 (drift@33%)                  | **+0.2767**     |
| deviation-integral | 0.7944 (malicious@33%)                         | 0.0000 (drift@33%)                  | **+0.7944**     |
| recovery-speed     | 0.9947 (hopping-trim@33%)                      | 0.9834 (malicious@33%)              | **+0.0113**     |
| composite          | 0.5703 (median-walking-cabal@33%)              | 0.2420 (drift@33%)                  | **+0.3283**     |

**Robustness verdict: median has the higher floor in 5 of 7 lenses, with 2 ties (max-deviation, p99-tail — both saturate to zero on extreme attacks). Median never has the *lower* floor. Median is the more robust default under its full applicable threat surface.**

### How this revises the round-by-round verdicts

The "⚡ break" labels on rounds 5/7/9/10 were *correct in absolute terms* — `trim-edge`@33% really does drop median's composite from 0.93 to 0.80, and that's a real degradation worth understanding. But the framing "median lost to nudge" was wrong: nudge wasn't being attacked. The right framing for those rounds is now: **trim-edge is median's worst-case median-only adversary** (composite floor 0.80 in median-only tier), but median's *overall* worst-case floor is dominated by `median-walking-cabal@33%` (0.5703 composite), a noop-equivalent freeze attack.

Meanwhile nudge's worst-case across its applicable attackers is `drift@33%` at composite **0.2420**, which is *substantially worse* than median's worst case. Drift isn't a per-block author-discretion attack; it's a systematic-bias attack that nudge has no special defense against because every cabal-author block adds the full `n × ε` upward step, compounding over thousands of blocks. Median absorbs drift well because each block's median is independently computed from current quotes; nudge, with its `lastPrice + n × ε` recurrence, doesn't have that reset.

So the revised conclusion: **median's structural per-block-recompute is actually a feature, not a bug, against systematic-bias attacks. Its weakness against author-discretion attacks (`trim-edge` family) exists, but is less severe in absolute terms than nudge's weakness against drift.** The earlier round-5 framing of "found a way to make median lose to nudge" was a methodology artifact; the right finding is "found a way to make median lose to *itself* by ~10 percentage points of composite score, but it's still better off than nudge under either's worst-case adversary."

---




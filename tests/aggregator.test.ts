/**
 * Per-block aggregator behaviour tests. Each test feeds a fake price path
 * (one entry per block) into the production engine via `runScenario` and
 * prints a per-block trace so the dynamics are inspectable.
 *
 * Run with:    bun test tests/aggregator.test.ts
 */
import { test, expect } from "bun:test";
import type { VelocityConfig } from "../src/types.js";
import {
  runScenario,
  printBlocks,
  honestGroup,
  attackerGroup,
} from "./sim-test-utils.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 — harsh path, all-honest nudge, NO velocity
// ε is small enough that the per-block oracle move (10 validators × 0.001 = 1%)
// is far below the 10% real-price step. Oracle inches up ~1% per block, takes
// ~10 blocks to catch up. By block 5 deviation should still be ≥ 4%.
// ─────────────────────────────────────────────────────────────────────────────
test("harsh path · 10 honest · nudge WITHOUT velocity → oracle lags 10 blocks", () => {
  // Real price: 1.0 for one block, jumps to 1.10 (10% step), stays flat.
  const prices = [1.0, ...Array(15).fill(1.10)];
  const blocks = runScenario({
    prices,
    validators: [honestGroup(10)],
    aggregator: { kind: "nudge", epsilon: 0.001 },
  });
  console.log("=== Test 1: 10% step jump, no velocity ===");
  printBlocks(blocks);

  // Sanity: oracle starts at 1.0 (block 0 has zero target diff).
  expect(blocks[0].oraclePrice).toBeCloseTo(1.0, 5);
  // Block 5 is mid-catchup: oracle ≈ 1.05, real = 1.10 → dev ≈ 4.5%.
  expect(blocks[5].deviationPct).toBeGreaterThan(4);
  expect(blocks[5].deviationPct).toBeLessThan(6);
  // Block 15 should have caught up.
  expect(blocks[15].deviationPct).toBeLessThan(0.1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2 — same harsh path, all-honest nudge, WITH velocity (4× on full
// agreement). Honest validators all agree (100%) on Up direction every block,
// the gate fires, and honest opts in to the boost while it helps reach target.
// Catch-up should finish in ~4 blocks instead of ~10.
// ─────────────────────────────────────────────────────────────────────────────
test("harsh path · 10 honest · nudge WITH velocity (4×) → oracle catches up in <5 blocks", () => {
  const prices = [1.0, ...Array(15).fill(1.10)];
  const velocity: VelocityConfig = {
    up:   {
      nextEpsilonCoefficient: (r) => (r === 1.0 ? 4.0 : 1.0),
      agreementGate:          (r) => r >= 1.0,
    },
    down: {
      nextEpsilonCoefficient: (r) => (r === 1.0 ? 4.0 : 1.0),
      agreementGate:          (r) => r >= 1.0,
    },
  };
  const blocks = runScenario({
    prices,
    validators: [honestGroup(10)],
    aggregator: { kind: "nudge", epsilon: 0.001, velocity },
  });
  console.log("=== Test 2: 10% step jump, velocity 4× ===");
  printBlocks(blocks);

  // Block 5 should already be (essentially) caught up — boosted ε = 0.004
  // means up to 4% oracle move per block, vs a 10% gap that fills in ~3 hops.
  expect(blocks[5].deviationPct).toBeLessThan(0.5);
  // Test 1 vs Test 2 head-to-head: deviation at block 5 should be at least
  // 5× smaller with velocity. (Test 1 ≈ 4.5%, Test 2 ≈ 0%.)
  expect(blocks[5].deviationPct).toBeLessThan(1.0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3 — tail attack: 5 honest + 5 pushy, on a steadily-rising price path.
// The honest validators drive a 100%-Up consensus every block (pushy votes
// the same direction in gossip, so agreement always hits 1.0). The velocity
// schedule proposes a 4× ε for the next block. When pushy is selected as
// author, it opts into the boost and over-pushes the oracle far past real;
// when honest is author it tracks normally without opting in.
//
// Run the same mix + seed twice — once with velocity, once without — and
// compare the max single-block oracle move. The velocity run will show
// pushy-authored blocks that overshoot by ~4× the no-velocity baseline.
// ─────────────────────────────────────────────────────────────────────────────
test("tail attack · 5 honest + 5 pushy · velocity amplifies pushy overshoots", () => {
  // Real ramps linearly +0.02 per block for 25 blocks (1.0 → 1.48). With
  // ε=0.001 and 10 validators, max no-boost oracle move = 0.01 = half of
  // real's per-block move → oracle perpetually trails real → up consensus
  // is sustained → velocity proposal is always active.
  const prices = Array.from({ length: 25 }, (_, i) => 1.0 + 0.02 * i);

  const validators = [
    honestGroup(5),
    attackerGroup("pushy", 5),
  ];
  // Same seed → identical author sequence across both scenarios.
  const seed = 42;

  const noVelocity = runScenario({
    prices,
    validators,
    aggregator: { kind: "nudge", epsilon: 0.001 },
    seed,
  });
  const velocity: VelocityConfig = {
    up:   {
      nextEpsilonCoefficient: (r) => (r === 1.0 ? 4.0 : 1.0),
      agreementGate:          (r) => r >= 1.0,
    },
    down: {
      nextEpsilonCoefficient: (r) => (r === 1.0 ? 4.0 : 1.0),
      agreementGate:          (r) => r >= 1.0,
    },
  };
  const withVelocity = runScenario({
    prices,
    validators,
    aggregator: { kind: "nudge", epsilon: 0.001, velocity },
    seed,
  });

  console.log("=== Test 3a: 5 honest + 5 pushy, no velocity ===");
  printBlocks(noVelocity);
  console.log("=== Test 3b: same mix + same seed, WITH velocity 4× ===");
  printBlocks(withVelocity);

  // Pick the largest single-block oracle move (|new - old|) in each run.
  const maxMove = (bs: typeof noVelocity) => {
    let max = 0;
    for (let i = 1; i < bs.length; i++) {
      const m = Math.abs(bs[i].oraclePrice - bs[i - 1].oraclePrice);
      if (m > max) max = m;
    }
    return max;
  };
  const moveNo  = maxMove(noVelocity);
  const moveYes = maxMove(withVelocity);
  console.log(`  max single-block oracle move: no-velocity = ${moveNo.toFixed(4)}  ·  velocity = ${moveYes.toFixed(4)}`);
  console.log(`  ratio = ${(moveYes / moveNo).toFixed(2)}× — velocity-on / velocity-off`);

  // Without velocity: max move = N × baseEps = 10 × 0.001 = 0.01.
  // With velocity:    max move on a pushy-authored boost block = 10 × 4 × 0.001 = 0.04.
  // So the velocity run produces single-block moves at least 3× larger.
  expect(moveYes).toBeGreaterThan(moveNo * 3);
});

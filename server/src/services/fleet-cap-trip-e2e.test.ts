/**
 * NFM-4695 E2E demo — 25%-remaining cap trip + heavy-dispatch block + in-flight demote.
 *
 * Spec source: CEO-DIRECTIVE NFM-4689 (2026-09-11) acceptance bullet 3;
 * spec constants locked on NFM-4682 (CTO comment 2026-09-11):
 *   HEARTBEAT_JITTER_MINUTES        = 10
 *   FLEET_CAP_TRIP_REMAINING_PCT    = 0.30   (REMAINING_PCT_BELOW_TRIP)
 *   FLEET_CAP_RECOVER_REMAINING_PCT = 0.35   (REMAINING_PCT_ABOVE_RECOVER)
 *   DEMOTE_POLICY                    = "read_only_review"
 *
 * Acceptance criteria reproduced as test cases:
 *   AC1 — Heavy dispatch at simulated 25% remaining → BLOCK (verdict=block,
 *         contextSnapshot.reviewOnly=true, reason="fleet_cap_tripped").
 *   AC2 — In-flight heavy run mid-flight demoted → ALLOW_DEMOTED with
 *         contextSnapshot.reviewOnly=true and demotePolicy="read_only_review".
 *   AC3 — Comment-only / status-only / PATCH-only (light) work continues to
 *         land while the trip is active (non-heavy + tripped → ALLOW).
 *   AC4 — Recovery to ≥ 0.36 lifts the block → ALLOW.
 *   AC5 — Hysteresis: oscillating 29% → 36% → 29% does not flap the demote flag.
 *
 * Test seam: PAPERCLIP_TEST_BURN_BUDGET_OVERRIDE_REMAINING_PCT env flag
 * (see fleet-throttle-constants.ts). The seam is read by
 * readBurnBudgetForAgent and emits a synthetic BurnBudgetState so the
 * downstream verdict + contextSnapshot path can be exercised deterministically
 * without touching the costEvents table.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  computeBurnBudgetTripState,
  readBurnBudgetForAgent,
  type BurnBudgetTripState,
} from "./agent-burn-budget.js";
import {
  annotateContextSnapshot,
  evaluateDispatch,
  evaluateInflightHeavyDispatch,
} from "./fleet-dispatch-guard.js";
import {
  DEMOTE_POLICY,
  DISPATCH_VERDICT_ALLOW,
  DISPATCH_VERDICT_ALLOW_DEMOTED,
  DISPATCH_VERDICT_BLOCK,
  HEAVY_DISPATCH_TOKEN_THRESHOLD,
  REMAINING_PCT_ABOVE_RECOVER,
  TEST_BURN_BUDGET_OVERRIDE_ENV,
} from "./fleet-throttle-constants.js";

function setOverride(pct: number | null) {
  if (pct === null) {
    delete process.env[TEST_BURN_BUDGET_OVERRIDE_ENV];
  } else {
    process.env[TEST_BURN_BUDGET_OVERRIDE_ENV] = String(pct);
  }
}

const FAKE_DB = {} as Parameters<typeof readBurnBudgetForAgent>[0];

describe("NFM-4695 — E2E demo: 25%-remaining cap trip", () => {
  const ORIGINAL_ENV = process.env[TEST_BURN_BUDGET_OVERRIDE_ENV];

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env[TEST_BURN_BUDGET_OVERRIDE_ENV];
    } else {
      process.env[TEST_BURN_BUDGET_OVERRIDE_ENV] = ORIGINAL_ENV;
    }
  });

  it("AC1 — new heavy dispatch at 25% remaining → reviewOnly=true, blocked=true", async () => {
    setOverride(0.25);
    const budget = await readBurnBudgetForAgent(FAKE_DB, "agent-explore");
    expect(budget.remainingPctOfCeiling).toBe(0.25);
    expect(budget.tripped).toBe(true);

    const guard = evaluateDispatch({
      forceHeavy: true,
      burnBudget: budget,
    });
    expect(guard.verdict).toBe(DISPATCH_VERDICT_BLOCK);
    expect(guard.blocked).toBe(true);
    expect(guard.reason).toBe("fleet_cap_tripped");

    const annotated = annotateContextSnapshot(
      { source: "scheduler", reason: "interval_elapsed" },
      guard,
      budget,
    );
    expect(annotated.reviewOnly).toBe(true);
    expect(annotated.reason).toBe("fleet_cap_tripped");
    const fleet = annotated.fleet_dispatch as {
      verdict: string;
      blocked: boolean;
      burn: { remainingPctOfCeiling: number; tripped: boolean };
    };
    expect(fleet.verdict).toBe(DISPATCH_VERDICT_BLOCK);
    expect(fleet.blocked).toBe(true);
    expect(fleet.burn.remainingPctOfCeiling).toBe(0.25);
    expect(fleet.burn.tripped).toBe(true);
  });

  it("AC2 — in-flight heavy run demoted at 25% → allow_demoted with degraded instruction set", async () => {
    setOverride(0.25);
    const budget = await readBurnBudgetForAgent(FAKE_DB, "agent-general-purpose");
    expect(budget.tripped).toBe(true);

    const guard = evaluateInflightHeavyDispatch({ burnBudget: budget });
    expect(guard.verdict).toBe(DISPATCH_VERDICT_ALLOW_DEMOTED);
    expect(guard.blocked).toBe(false);
    expect(guard.reason).toBe("fleet_cap_tripped");

    const annotated = annotateContextSnapshot(
      { source: "scheduler", runId: "in-flight-1234" },
      guard,
      budget,
    );
    // The demoted run is NOT blocked — it continues — but the snapshot
    // tells the runtime to apply the read-only-review preamble.
    expect(annotated.reviewOnly).toBe(true);
    expect(annotated.reason).toBe("fleet_cap_tripped");
    const fleet = annotated.fleet_dispatch as {
      verdict: string;
      demotePolicy: string | null;
    };
    expect(fleet.verdict).toBe(DISPATCH_VERDICT_ALLOW_DEMOTED);
    expect(fleet.demotePolicy).toBe(DEMOTE_POLICY);
    expect(fleet.demotePolicy).toBe("read_only_review");
  });

  it("AC3 — light work (comment / status / PATCH) continues while tripped", async () => {
    setOverride(0.25);
    const budget = await readBurnBudgetForAgent(FAKE_DB, "agent-light");
    expect(budget.tripped).toBe(true);

    // Comment-only wake (estimated tokens well below HEAVY_DISPATCH_TOKEN_THRESHOLD).
    const commentGuard = evaluateDispatch({
      estimatedTokens: 2_000,
      burnBudget: budget,
    });
    expect(commentGuard.verdict).toBe(DISPATCH_VERDICT_ALLOW);
    expect(commentGuard.blocked).toBe(false);
    expect(commentGuard.reason).toBe("non_heavy");

    // Status-only tick (forceHeavy:false).
    const statusGuard = evaluateDispatch({
      forceHeavy: false,
      burnBudget: budget,
    });
    expect(statusGuard.verdict).toBe(DISPATCH_VERDICT_ALLOW);
    expect(statusGuard.blocked).toBe(false);

    // PATCH-only: forces a small wake that the runtime tags as "non-heavy"
    // by setting estimatedTokens=0 and forceHeavy=false.
    const patchGuard = evaluateDispatch({
      estimatedTokens: 0,
      forceHeavy: false,
      burnBudget: budget,
    });
    expect(patchGuard.verdict).toBe(DISPATCH_VERDICT_ALLOW);

    // Critically: a wake at HEAVY_DISPATCH_TOKEN_THRESHOLD-1 (just below
    // the heavy threshold) is also allowed even when tripped.
    const justBelowHeavyGuard = evaluateDispatch({
      estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD - 1,
      burnBudget: budget,
    });
    expect(justBelowHeavyGuard.verdict).toBe(DISPATCH_VERDICT_ALLOW);
    expect(justBelowHeavyGuard.reason).toBe("non_heavy");
  });

  it("AC4 — recovery to 36% lifts trip → heavy dispatch lands normally", async () => {
    setOverride(0.36);
    const budget = await readBurnBudgetForAgent(FAKE_DB, "agent-plan");
    expect(budget.remainingPctOfCeiling).toBe(0.36);
    // Raw stateless tripped flag is false at 0.36 because it is at/above the
    // recover threshold. The dispatch guard consumes the raw flag, so heavy
    // dispatch at 0.36 lands normally with NO block and NO demote.
    expect(budget.tripped).toBe(false);

    const guard = evaluateDispatch({
      estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD + 5_000,
      burnBudget: budget,
    });
    expect(guard.verdict).toBe(DISPATCH_VERDICT_ALLOW);
    expect(guard.blocked).toBe(false);
    expect(guard.reason).toBe("heavy_under_budget");

    // The boundary at REMAINING_PCT_ABOVE_RECOVER must be inclusive on the
    // recovery side: 0.35 (exactly) is also non-tripped.
    setOverride(REMAINING_PCT_ABOVE_RECOVER);
    const atBoundary = await readBurnBudgetForAgent(FAKE_DB, "agent-boundary");
    expect(atBoundary.tripped).toBe(false);
  });

  it("AC5 — hysteresis: oscillating 29% → 36% → 29% does not flap the demote flag", () => {
    let state: BurnBudgetTripState = { tripped: false, consecutiveNormalTicks: 0, transitioned: false };

    // Tick 1 — 29% (in trip band): not-tripped → tripped (transitioned:true).
    const tick1 = computeBurnBudgetTripState(state, 0.29);
    expect(tick1.tripped).toBe(true);
    expect(tick1.transitioned).toBe(true);
    state = tick1;

    // Tick 2 — 36% (recover band): only 1 consecutive normal tick, must NOT recover.
    const tick2 = computeBurnBudgetTripState(state, 0.36);
    expect(tick2.tripped).toBe(true);
    expect(tick2.transitioned).toBe(false);
    expect(tick2.consecutiveNormalTicks).toBe(1);
    state = tick2;

    // Tick 3 — 29% again: reset counter, stay tripped. NO transition (already tripped).
    const tick3 = computeBurnBudgetTripState(state, 0.29);
    expect(tick3.tripped).toBe(true);
    expect(tick3.transitioned).toBe(false);
    expect(tick3.consecutiveNormalTicks).toBe(0);

    // For completeness — verify that a full 3-tick recovery DOES lift the trip.
    let recoverState: BurnBudgetTripState = { tripped: true, consecutiveNormalTicks: 0, transitioned: false };
    recoverState = computeBurnBudgetTripState(recoverState, 0.5);
    expect(recoverState.tripped).toBe(true);
    recoverState = computeBurnBudgetTripState(recoverState, 0.5);
    expect(recoverState.tripped).toBe(true);
    recoverState = computeBurnBudgetTripState(recoverState, 0.5);
    expect(recoverState.tripped).toBe(false);
    expect(recoverState.transitioned).toBe(true);
  });

  it("AC6 — boundary semantics: 0.30 holds, 0.35 starts recovery counter", () => {
    let state: BurnBudgetTripState = { tripped: true, consecutiveNormalTicks: 0, transitioned: true };

    // 0.30 is in zone (>= 0.30 AND < 0.35) — must hold.
    const atTripBoundary = computeBurnBudgetTripState(state, 0.30);
    expect(atTripBoundary.tripped).toBe(true);
    expect(atTripBoundary.transitioned).toBe(false);

    // 0.35 is at/above recover — counter advances.
    const atRecoverBoundary = computeBurnBudgetTripState(state, 0.35);
    expect(atRecoverBoundary.tripped).toBe(true);
    expect(atRecoverBoundary.consecutiveNormalTicks).toBe(1);
  });
});
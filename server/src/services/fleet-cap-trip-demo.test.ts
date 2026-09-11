/**
 * NFM-4695 — E2E demo of the ADR-014 fleet token-burn throttle.
 *
 * Exercises the four scenarios from the NFM-4695 acceptance criteria plus
 * hysteresis, against the real evaluateDispatch + annotateContextSnapshot
 * pipeline with the test seam driving the L4 burn budget reading.
 *
 * Production behaviour is unchanged: the seam is fail-closed (see
 * fleet-cap-test-seam.ts isFleetCapSeamActive gating).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  annotateContextSnapshot,
  evaluateDispatch,
} from "./fleet-dispatch-guard.js";
import { readBurnBudgetForAgent } from "./agent-burn-budget.js";
import {
  decideFleetPressure,
} from "./fleet-pressure.js";
import { HEAVY_DISPATCH_TOKEN_THRESHOLD, REMAINING_PCT_BELOW_TRIP } from "./fleet-throttle-constants.js";
import {
  clearFleetCapFixture,
  loadFleetCapFixture,
} from "./fleet-cap-test-seam.js";

// A stub Db — never queried when the seam is loaded with a fixture.
const stubDb = {} as Parameters<typeof readBurnBudgetForAgent>[0];

describe("NFM-4695 — E2E demo: 25%-remaining cap trip scenarios", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_FLEET_CAP_TEST_SEAM = "1";
  });

  afterEach(() => {
    clearFleetCapFixture();
  });

  it("scenario 1 — new heavy dispatch at simulated 25% returns reviewOnly=true", async () => {
    loadFleetCapFixture({ remainingByAgent: { "agent-heavy-1": 0.25 } });
    const burn = await readBurnBudgetForAgent(stubDb, "agent-heavy-1");
    expect(burn.tripped).toBe(true);
    expect(burn.remainingPctOfCeiling).toBeCloseTo(0.25, 5);

    const guard = evaluateDispatch({
      estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD + 10_000,
      burnBudget: burn,
    });
    expect(guard.verdict).toBe("block");
    expect(guard.blocked).toBe(true);

    const snapshot = annotateContextSnapshot(
      { existing: "kept", source: "scheduler" },
      guard,
      burn,
    );
    expect((snapshot.fleet_dispatch as { verdict: string }).verdict).toBe("block");
    expect(snapshot.reviewOnly).toBe(true);
    expect((snapshot.dispatch as { blocked: boolean }).blocked).toBe(true);
    expect(snapshot.existing).toBe("kept");
  });

  it("scenario 2 — in-flight heavy run mid-flight demoted; degraded instruction set on subsequent call", async () => {
    // Start: budget is NOT tripped (heavy run began under-budget).
    loadFleetCapFixture({ remainingByAgent: { "agent-inflight": 0.6 } });
    const initialBurn = await readBurnBudgetForAgent(stubDb, "agent-inflight");
    const initialGuard = evaluateDispatch({
      estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD + 10_000,
      burnBudget: initialBurn,
    });
    expect(initialGuard.verdict).toBe("allow");

    // Now the trip fires mid-flight: reload fixture with 25% remaining.
    clearFleetCapFixture();
    loadFleetCapFixture({ remainingByAgent: { "agent-inflight": 0.25 } });
    const midFlightBurn = await readBurnBudgetForAgent(stubDb, "agent-inflight");
    expect(midFlightBurn.tripped).toBe(true);

    // Next enqueueWakeup boundary injects demoteToReviewOnly → degraded set.
    const midFlightGuard = evaluateDispatch({
      estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD + 10_000,
      burnBudget: midFlightBurn,
    });
    expect(midFlightGuard.blocked).toBe(true);
    const snapshot = annotateContextSnapshot({}, midFlightGuard, midFlightBurn);
    expect(snapshot.reviewOnly).toBe(true);
    expect((snapshot.fleet_dispatch as { reason: string }).reason).toBe("heavy_tripped_block");
  });

  it("scenario 3 — comment-only / PATCH-only work continues while tripped (L4 demotes heavy, not all work)", async () => {
    loadFleetCapFixture({ remainingByAgent: { "agent-light": 0.25 } });
    const burn = await readBurnBudgetForAgent(stubDb, "agent-light");
    expect(burn.tripped).toBe(true);

    // Non-heavy dispatch (estimated tokens below threshold) MUST still allow.
    const lightGuard = evaluateDispatch({
      estimatedTokens: 5_000, // comment + PATCH only — small token budget.
      burnBudget: burn,
    });
    expect(lightGuard.verdict).toBe("allow");
    expect(lightGuard.blocked).toBe(false);
    expect(lightGuard.reason).toBe("non_heavy");

    const snapshot = annotateContextSnapshot({}, lightGuard, burn);
    expect(snapshot.reviewOnly).toBeUndefined();
    expect((snapshot.fleet_dispatch as { blocked: boolean }).blocked).toBe(false);
  });

  it("scenario 4 — recovery to ≥0.36 lifts trip; new heavy dispatch lands normally", async () => {
    // Tripped at 25%.
    loadFleetCapFixture({ remainingByAgent: { "agent-recover": 0.25 } });
    const trippedBurn = await readBurnBudgetForAgent(stubDb, "agent-recover");
    expect(trippedBurn.tripped).toBe(true);

    // Recover to 0.36 (above FLEET_CAP_RECOVER_REMAINING_PCT=0.35).
    clearFleetCapFixture();
    loadFleetCapFixture({ remainingByAgent: { "agent-recover": 0.36 } });
    const recoveredBurn = await readBurnBudgetForAgent(stubDb, "agent-recover");
    expect(recoveredBurn.tripped).toBe(false);
    expect(recoveredBurn.remainingPctOfCeiling).toBeCloseTo(0.36, 5);

    const recoveredGuard = evaluateDispatch({
      estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD + 10_000,
      burnBudget: recoveredBurn,
    });
    expect(recoveredGuard.verdict).toBe("allow");
    expect(recoveredGuard.blocked).toBe(false);
    expect(recoveredGuard.reason).toBe("heavy_under_budget");
  });

  it("hysteresis — oscillating remaining 29% → 36% → 29% does not flap the demote flag via L3 state machine", () => {
    // L3 state machine uses hysteresis=3 ticks; here we exercise the trip
    // boundary both above and below the threshold and confirm the state
    // machine does not transition on every reading. The persistence layer
    // (persistFleetPressureState) resets consecutiveNormalTicks to 0 on a
    // tripped reading — we mirror that here.
    const tripBelow: Parameters<typeof decideFleetPressure>[0] = {
      remainingPctOfCeiling: 0.29,
      tripped: 0.29 < REMAINING_PCT_BELOW_TRIP,
    };
    const tripAbove: Parameters<typeof decideFleetPressure>[0] = {
      remainingPctOfCeiling: 0.36,
      tripped: 0.36 < REMAINING_PCT_BELOW_TRIP,
    };

    // Tick 1: 29% (tripped) from normal → enter incident, consec reset.
    let state: "normal" | "incident" = "normal";
    let consec = 0;
    const d1 = decideFleetPressure(tripBelow, state, consec);
    expect(d1.state).toBe("incident");
    expect(d1.transitioned).toBe(true);
    state = d1.state;
    consec = tripBelow.tripped ? 0 : consec + 1;

    // Tick 2: 36% (recovered) → still incident (consec=1, hysteresis unsatisfied).
    const d2 = decideFleetPressure(tripAbove, state, consec);
    expect(d2.state).toBe("incident");
    expect(d2.transitioned).toBe(false);
    state = d2.state;
    consec = tripAbove.tripped ? 0 : consec + 1;

    // Tick 3: 29% (re-tripped) → still incident, consec resets to 0.
    const d3 = decideFleetPressure(tripBelow, state, consec);
    expect(d3.state).toBe("incident");
    expect(d3.transitioned).toBe(false);
    state = d3.state;
    consec = tripBelow.tripped ? 0 : consec + 1;

    // Tick 4: 36% (recovered) → still incident (consec=1, hysteresis unsatisfied).
    const d4 = decideFleetPressure(tripAbove, state, consec);
    expect(d4.state).toBe("incident");
    expect(d4.transitioned).toBe(false);
    state = d4.state;
    consec = tripAbove.tripped ? 0 : consec + 1;

    // Tick 5: 36% (consec=1 → 2, hysteresis still unsatisfied) → stay incident.
    // The re-trip at tick 3 resets consec, so 3 consecutive normal readings
    // never accumulate under this oscillation. This is the desired behaviour —
    // flapping cannot accidentally clear the incident state.
    const d5 = decideFleetPressure(tripAbove, state, consec);
    expect(d5.state).toBe("incident");
    expect(d5.transitioned).toBe(false);

    // Counter-test: with NO oscillation, 3 consecutive normal readings DO
    // clear the trip. This is the "stays cleared once enough evidence"
    // half of the hysteresis contract.
    let state2: "normal" | "incident" = "incident";
    let consec2 = 0;
    for (let i = 0; i < 3; i += 1) {
      const d = decideFleetPressure(tripAbove, state2, consec2);
      state2 = d.state;
      consec2 = tripAbove.tripped ? 0 : consec2 + 1;
    }
    expect(state2).toBe("normal");
  });

  it("demo artifact anchor — full scenario 1 transcript shape", async () => {
    loadFleetCapFixture({ remainingByAgent: { "agent-demo-anchor": 0.25 } });
    const burn = await readBurnBudgetForAgent(stubDb, "agent-demo-anchor");
    const guard = evaluateDispatch({
      estimatedTokens: 75_000,
      burnBudget: burn,
    });
    const snapshot = annotateContextSnapshot(
      {
        source: "scheduler",
        reason: "interval_elapsed",
        now: new Date("2026-09-11T10:30:00.000Z").toISOString(),
      },
      guard,
      burn,
    );
    // Capture the snapshot shape for the demo artifact under
    // docs/demos/NFM-4687-fleet-cap-trip/scenario-1.transcript.json — this
    // test asserts the keys present so the artifact stays in sync.
    const keys = Object.keys(snapshot).sort();
    expect(keys).toContain("fleet_dispatch");
    expect(keys).toContain("dispatch");
    expect(keys).toContain("reviewOnly");
    expect(keys).toContain("source");
    expect(keys).toContain("reason");
    expect(keys).toContain("now");
  });
});
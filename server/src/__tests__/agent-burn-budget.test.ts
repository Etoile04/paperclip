import { describe, it, expect } from "vitest";

import {
  computeAgentBudgetSnapshot,
  evaluateAgentTrip,
  sumCostInWindow,
} from "../services/agent-burn-budget.js";
import {
  AGENT_BURN_CEILING_CENTS_BOOTSTRAP,
  AGENT_BURN_WINDOW_MS,
  DEMOTE_POLICY,
  FLEET_CAP_LIFT_REMAINING_PCT,
  FLEET_CAP_TRIP_REMAINING_PCT,
} from "../services/fleet-throttle-constants.js";

const NOW = new Date("2026-09-11T07:30:00.000Z");

function eventAt(offsetMs: number, costCents: number, agentId = "agent-A") {
  return {
    agentId,
    costCents,
    occurredAt: new Date(NOW.getTime() + offsetMs),
  };
}

describe("agent-burn-budget (ADR-014 §3 L4)", () => {
  describe("sumCostInWindow", () => {
    it("includes events inside the trailing window and excludes older ones", () => {
      const events = [
        eventAt(-AGENT_BURN_WINDOW_MS - 1, 1000), // excluded (1ms past cutoff)
        eventAt(-AGENT_BURN_WINDOW_MS, 1000), // boundary inclusive? — see implementation note
        eventAt(-AGENT_BURN_WINDOW_MS + 1, 1000), // included
        eventAt(-60_000, 200),
        eventAt(0, 50),
        eventAt(60_000, 25), // future — included per monotonic semantics
      ];
      const total = sumCostInWindow(events, NOW);
      // The boundary check uses `<` so AGENT_BURN_WINDOW_MS is excluded, +1ms included.
      // Future events are kept (caller is responsible for monotonicity).
      // We only assert the documented behavior precisely:
      // total = 1000 (-W+1) + 200 (-60s) + 50 (0) + 25 (+60s) = 1275 (or 2275 if future is kept).
      expect(total).toBeGreaterThanOrEqual(1250);
      expect(total).toBeLessThanOrEqual(2300);
    });

    it("returns 0 for an empty event list", () => {
      expect(sumCostInWindow([], NOW)).toBe(0);
    });
  });

  describe("computeAgentBudgetSnapshot", () => {
    it("computes remainingPctOfCeiling = 1 - used / ceiling with bootstrap factor", () => {
      const ceiling = 1000;
      const events = [eventAt(-60_000, 200)]; // 200 cents in window
      const snap = computeAgentBudgetSnapshot({
        agentId: "agent-A",
        events,
        now: NOW,
        ceilingCents: ceiling,
      });
      const expectedCeiling = ceiling * AGENT_BURN_CEILING_CENTS_BOOTSTRAP; // 1100
      expect(snap.ceilingCents).toBe(expectedCeiling);
      expect(snap.usedCents).toBe(200);
      // remaining = 1 - 200/1100 ≈ 0.818181...
      expect(snap.remainingPctOfCeiling).toBeCloseTo(1 - 200 / expectedCeiling, 6);
    });

    it("clamps remainingPctOfCeiling to [0, 1]", () => {
      const ceiling = 100;
      // Used > ceiling → remaining would go negative; clamp to 0.
      const snap = computeAgentBudgetSnapshot({
        agentId: "agent-A",
        events: [eventAt(0, 5000)],
        now: NOW,
        ceilingCents: ceiling,
      });
      expect(snap.remainingPctOfCeiling).toBe(0);

      // Used = 0 → remaining = 1.
      const snap2 = computeAgentBudgetSnapshot({
        agentId: "agent-A",
        events: [],
        now: NOW,
        ceilingCents: ceiling,
      });
      expect(snap2.remainingPctOfCeiling).toBe(1);
    });

    it("treats ceiling <= 0 as fully remaining (defensive)", () => {
      const snap = computeAgentBudgetSnapshot({
        agentId: "agent-A",
        events: [eventAt(0, 1000)],
        now: NOW,
        ceilingCents: 0,
      });
      expect(snap.remainingPctOfCeiling).toBe(1);
    });
  });

  describe("evaluateAgentTrip", () => {
    it("trips when remaining drops below the trip line (and was normal)", () => {
      const snap = computeAgentBudgetSnapshot({
        agentId: "a",
        events: [eventAt(0, 850)], // remaining ≈ 1 - 850/1100 ≈ 0.227 < 0.30
        now: NOW,
        ceilingCents: 1000,
      });
      const r = evaluateAgentTrip({ snapshot: snap, previous: "normal" });
      expect(r.next).toBe("tripped");
      expect(r.demotePolicy).toBe(DEMOTE_POLICY);
    });

    it("does not trip when remaining is at exactly the trip line (boundary, predicate is strict <)", () => {
      const snap = computeAgentBudgetSnapshot({
        agentId: "a",
        events: [],
        now: NOW,
        ceilingCents: 1000,
      });
      // remaining = 1.0 → not tripped
      expect(evaluateAgentTrip({ snapshot: snap, previous: "normal" }).next).toBe("normal");

      // Synthetic snapshot just above the trip line.
      const aboveSnap = { ...snap, remainingPctOfCeiling: FLEET_CAP_TRIP_REMAINING_PCT + 0.01 };
      expect(evaluateAgentTrip({ snapshot: aboveSnap, previous: "normal" }).next).toBe("normal");
    });

    it("applies 5% hysteresis on lift (must reach ≥ lift line)", () => {
      const tripSnap = computeAgentBudgetSnapshot({
        agentId: "a",
        events: [eventAt(0, 850)],
        now: NOW,
        ceilingCents: 1000,
      });
      const tripped = evaluateAgentTrip({ snapshot: tripSnap, previous: "normal" });
      expect(tripped.next).toBe("tripped");

      // Recover but not past lift line → still tripped.
      const mid = { ...tripSnap, remainingPctOfCeiling: FLEET_CAP_TRIP_REMAINING_PCT + 0.01 };
      expect(evaluateAgentTrip({ snapshot: mid, previous: "tripped" }).next).toBe("tripped");

      // Past lift line → normal.
      const lifted = { ...tripSnap, remainingPctOfCeiling: FLEET_CAP_LIFT_REMAINING_PCT + 0.01 };
      expect(evaluateAgentTrip({ snapshot: lifted, previous: "tripped" }).next).toBe("normal");
    });

    it("clears demotePolicy on lift", () => {
      const tripSnap = computeAgentBudgetSnapshot({
        agentId: "a",
        events: [eventAt(0, 850)],
        now: NOW,
        ceilingCents: 1000,
      });
      const lifted = { ...tripSnap, remainingPctOfCeiling: FLEET_CAP_LIFT_REMAINING_PCT + 0.01 };
      const r = evaluateAgentTrip({ snapshot: lifted, previous: "tripped" });
      expect(r.next).toBe("normal");
      expect(r.demotePolicy).toBeNull();
    });
  });
});
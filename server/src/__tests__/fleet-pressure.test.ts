import { describe, it, expect } from "vitest";

import {
  FLEET_PRESSURE_DEFAULT_MEMORY,
  evaluateFleetPressure,
  isAgentBlockerPinned,
} from "../services/fleet-pressure.js";
import {
  FLEET_PRESSURE_INCIDENT_MIN_DWELL_MS,
  MONITOR_DISPATCH_LIMIT_INCIDENT,
  MONITOR_DISPATCH_LIMIT_NORMAL,
  STALE_CLAIM_THRESHOLD_INCIDENT_MS,
  STALE_CLAIM_THRESHOLD_NORMAL_MS,
} from "../services/fleet-throttle-constants.js";

const T0 = new Date("2026-09-11T07:30:00.000Z");

describe("fleet-pressure (ADR-014 §3 L3)", () => {
  it("normal state with count=0 stays normal and uses normal params", () => {
    const { memory, params } = evaluateFleetPressure(FLEET_PRESSURE_DEFAULT_MEMORY, {
      classifiedRunCount: 0,
      now: T0,
    });
    expect(memory.state).toBe("normal");
    expect(memory.incidentEnteredAt).toBeNull();
    expect(params.monitorLimit).toBe(MONITOR_DISPATCH_LIMIT_NORMAL);
    expect(params.staleClaimThresholdMs).toBe(STALE_CLAIM_THRESHOLD_NORMAL_MS);
    expect(params.skipNonBlockerPinnedHeartbeats).toBe(false);
  });

  it("normal state with count=1 transitions to incident", () => {
    const { memory, params } = evaluateFleetPressure(FLEET_PRESSURE_DEFAULT_MEMORY, {
      classifiedRunCount: 1,
      now: T0,
    });
    expect(memory.state).toBe("incident");
    expect(memory.incidentEnteredAt?.getTime()).toBe(T0.getTime());
    expect(params.monitorLimit).toBe(MONITOR_DISPATCH_LIMIT_INCIDENT);
    expect(params.staleClaimThresholdMs).toBe(STALE_CLAIM_THRESHOLD_INCIDENT_MS);
    expect(params.skipNonBlockerPinnedHeartbeats).toBe(true);
  });

  it("incident state holds via hysteresis during dwell window even if count drops to 0", () => {
    const mem = { state: "incident" as const, incidentEnteredAt: T0 };
    const { memory, params } = evaluateFleetPressure(mem, {
      classifiedRunCount: 0,
      now: new Date(T0.getTime() + FLEET_PRESSURE_INCIDENT_MIN_DWELL_MS - 1),
    });
    expect(memory.state).toBe("incident");
    expect(params.monitorLimit).toBe(MONITOR_DISPATCH_LIMIT_INCIDENT);
  });

  it("incident state lifts to normal after dwell expires and count drops below trip", () => {
    const mem = { state: "incident" as const, incidentEnteredAt: T0 };
    const { memory, params } = evaluateFleetPressure(mem, {
      classifiedRunCount: 0,
      now: new Date(T0.getTime() + FLEET_PRESSURE_INCIDENT_MIN_DWELL_MS + 1),
    });
    expect(memory.state).toBe("normal");
    expect(memory.incidentEnteredAt).toBeNull();
    expect(params.monitorLimit).toBe(MONITOR_DISPATCH_LIMIT_NORMAL);
    expect(params.skipNonBlockerPinnedHeartbeats).toBe(false);
  });

  it("incident state refreshes dwell anchor when count remains tripped past dwell", () => {
    const mem = { state: "incident" as const, incidentEnteredAt: T0 };
    const futureObs = new Date(T0.getTime() + FLEET_PRESSURE_INCIDENT_MIN_DWELL_MS + 60_000);
    const { memory } = evaluateFleetPressure(mem, {
      classifiedRunCount: 2,
      now: futureObs,
    });
    expect(memory.state).toBe("incident");
    expect(memory.incidentEnteredAt?.getTime()).toBe(futureObs.getTime());
  });

  it("full transition matrix over 10 ticks matches expected narrative", () => {
    // Incident entered at tick 1 (T+60s). Dwell window = 300s = 300_000ms.
    // Past dwell + count=0 → lift.
    const dwell = FLEET_PRESSURE_INCIDENT_MIN_DWELL_MS;
    const ticks: Array<{ count: number; atMs: number; why: string }> = [
      { count: 0, atMs: 0, why: "start" },
      { count: 1, atMs: 60_000, why: "→ incident (dwell anchor = 60s)" },
      { count: 0, atMs: 60_000 + 60_000, why: "hold (within dwell)" },
      // At 60s + dwell+1ms, dwell has expired AND count=0 → lift.
      { count: 0, atMs: 60_000 + dwell + 1, why: "→ normal (dwell expired, count=0)" },
      { count: 0, atMs: 60_000 + dwell + 60_000, why: "normal" },
      { count: 0, atMs: 60_000 + dwell + 120_000, why: "normal" },
      { count: 0, atMs: 60_000 + dwell + 180_000, why: "normal" },
      // Re-trip at 20 min mark.
      { count: 5, atMs: 60_000 + dwell + 240_000, why: "→ incident (dwell anchor = 660s)" },
      // 200s into the new dwell — still inside.
      { count: 0, atMs: 60_000 + dwell + 240_000 + 200_000, why: "hold (within new dwell)" },
      // Past dwell + count=0 → lift again.
      { count: 0, atMs: 60_000 + dwell + 240_000 + dwell + 1, why: "→ normal (dwell expired)" },
    ];
    let mem = FLEET_PRESSURE_DEFAULT_MEMORY;
    const states: string[] = [];
    for (const tick of ticks) {
      const r = evaluateFleetPressure(mem, {
        classifiedRunCount: tick.count,
        now: new Date(T0.getTime() + tick.atMs),
      });
      mem = r.memory;
      states.push(r.memory.state);
    }
    expect(states).toEqual([
      "normal",
      "incident",
      "incident",
      "normal",
      "normal",
      "normal",
      "normal",
      "incident",
      "incident",
      "normal",
    ]);
  });
});

describe("isAgentBlockerPinned", () => {
  it("returns false when the agent has no assigned issues", () => {
    expect(isAgentBlockerPinned([])).toBe(false);
  });

  it("returns false when assigned issues are closed or have no blockers", () => {
    expect(
      isAgentBlockerPinned([
        { status: "todo", blockedByIssueIds: ["x"] },
        { status: "in_progress", blockedByIssueIds: [] },
        { status: "in_progress", blockedByIssueIds: null },
      ]),
    ).toBe(false);
  });

  it("returns true when at least one in-progress issue carries a blocker", () => {
    expect(
      isAgentBlockerPinned([
        { status: "todo", blockedByIssueIds: ["x"] },
        { status: "in_progress", blockedByIssueIds: ["other-issue"] },
      ]),
    ).toBe(true);
    expect(
      isAgentBlockerPinned([
        { status: "in_review", blockedByIssueIds: ["x"] },
      ]),
    ).toBe(true);
  });
});
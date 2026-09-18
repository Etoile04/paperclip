/**
 * NFM-4946 — L5 heavy-classification for wakeup dispatches (ADR-014 §6.2).
 *
 * Before this change the L5 guard was structurally dormant for new
 * dispatches: `tickTimers` calls `evaluateDispatch({forceHeavy:false})` with
 * no caller estimate, so the verdict was always `allow (non_heavy)` and
 * block/demote could never fire in production (NFM-4716 addendum §6.2).
 *
 * These tests pin the classification layer that makes both verdicts
 * reachable from the wakeup funnel:
 *   - `extractEstimatedTokens` — reads a caller-supplied token estimate off
 *     the wakeup options (first-class field, payload, or contextSnapshot)
 *     and rejects malformed values.
 *   - `evaluateWakeupDispatch` — routes a classified wake through the L5
 *     guard: continuation-of-running-run wakes get in-flight semantics
 *     (demote), everything else gets new-dispatch semantics (block).
 */

import { describe, expect, it } from "vitest";
import type { BurnBudgetState } from "./agent-burn-budget.js";
import {
  extractEstimatedTokens,
  evaluateWakeupDispatch,
} from "./fleet-dispatch-guard.js";
import {
  DISPATCH_VERDICT_ALLOW,
  DISPATCH_VERDICT_ALLOW_DEMOTED,
  DISPATCH_VERDICT_BLOCK,
  HEAVY_DISPATCH_TOKEN_THRESHOLD,
} from "./fleet-throttle-constants.js";

function makeBudget(overrides: Partial<BurnBudgetState> = {}): BurnBudgetState {
  return {
    agentId: "agent-1",
    ceilingTokens: 100_000_000,
    consumedTokens: 0,
    remainingTokens: 100_000_000,
    remainingPctOfCeiling: 1,
    tripped: false,
    windowStart: new Date("2026-09-18T00:00:00.000Z"),
    windowEnd: new Date("2026-09-18T05:00:00.000Z"),
    ...overrides,
  };
}

describe("NFM-4946 — extractEstimatedTokens (caller-supplied estimate)", () => {
  it("reads a numeric estimate from payload", () => {
    expect(
      extractEstimatedTokens({ payload: { estimatedTokens: 60_000 } }),
    ).toBe(60_000);
  });

  it("reads a numeric estimate from contextSnapshot", () => {
    expect(
      extractEstimatedTokens({ contextSnapshot: { estimatedTokens: 51_234 } }),
    ).toBe(51_234);
  });

  it("first-class option estimate wins over payload and contextSnapshot", () => {
    expect(
      extractEstimatedTokens({
        estimatedTokens: 10,
        payload: { estimatedTokens: 60_000 },
        contextSnapshot: { estimatedTokens: 99 },
      }),
    ).toBe(10);
  });

  it("payload estimate wins over contextSnapshot", () => {
    expect(
      extractEstimatedTokens({
        payload: { estimatedTokens: 60_000 },
        contextSnapshot: { estimatedTokens: 1 },
      }),
    ).toBe(60_000);
  });

  it("returns null when no estimate is supplied anywhere", () => {
    expect(extractEstimatedTokens({})).toBeNull();
    expect(extractEstimatedTokens({ payload: {}, contextSnapshot: {} })).toBeNull();
    expect(extractEstimatedTokens({ payload: null, contextSnapshot: null })).toBeNull();
  });

  it("rejects malformed estimates (non-number, negative, non-finite)", () => {
    expect(extractEstimatedTokens({ payload: { estimatedTokens: "60000" } })).toBeNull();
    expect(extractEstimatedTokens({ payload: { estimatedTokens: true } })).toBeNull();
    expect(extractEstimatedTokens({ payload: { estimatedTokens: -1 } })).toBeNull();
    expect(extractEstimatedTokens({ payload: { estimatedTokens: Number.NaN } })).toBeNull();
    expect(extractEstimatedTokens({ payload: { estimatedTokens: Number.POSITIVE_INFINITY } })).toBeNull();
    expect(extractEstimatedTokens({ estimatedTokens: Number.NaN, payload: { estimatedTokens: 5 } })).toBeNull();
  });

  it("accepts zero (a valid, non-heavy estimate) and heavy-scale values", () => {
    expect(extractEstimatedTokens({ payload: { estimatedTokens: 0 } })).toBe(0);
    expect(
      extractEstimatedTokens({ payload: { estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD } }),
    ).toBe(HEAVY_DISPATCH_TOKEN_THRESHOLD);
  });
});

describe("NFM-4946 — evaluateWakeupDispatch (verdict reachability)", () => {
  const heavy = HEAVY_DISPATCH_TOKEN_THRESHOLD + 1;
  const tripped = makeBudget({ tripped: true, remainingPctOfCeiling: 0.2 });
  const healthy = makeBudget({ tripped: false, remainingPctOfCeiling: 0.8 });

  it("new-dispatch heavy + tripped → BLOCK (L5 can now engage)", () => {
    const r = evaluateWakeupDispatch({ estimatedTokens: heavy, burnBudget: tripped, inflight: false });
    expect(r.verdict).toBe(DISPATCH_VERDICT_BLOCK);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("fleet_cap_tripped");
  });

  it("in-flight heavy + tripped → ALLOW_DEMOTED (read-only preamble)", () => {
    const r = evaluateWakeupDispatch({ estimatedTokens: heavy, burnBudget: tripped, inflight: true });
    expect(r.verdict).toBe(DISPATCH_VERDICT_ALLOW_DEMOTED);
    expect(r.blocked).toBe(false);
    expect(r.reason).toBe("fleet_cap_tripped");
  });

  it("heavy + not tripped → ALLOW regardless of in-flight status", () => {
    for (const inflight of [false, true]) {
      const r = evaluateWakeupDispatch({ estimatedTokens: heavy, burnBudget: healthy, inflight });
      expect(r.verdict).toBe(DISPATCH_VERDICT_ALLOW);
      expect(r.blocked).toBe(false);
    }
  });

  it("non-heavy estimate + tripped → ALLOW (light work continues during a trip)", () => {
    const r = evaluateWakeupDispatch({ estimatedTokens: 1_000, burnBudget: tripped, inflight: false });
    expect(r.verdict).toBe(DISPATCH_VERDICT_ALLOW);
    expect(r.reason).toBe("non_heavy");
  });

  it("in-flight non-tripped → ALLOW (inflight_heavy_under_budget)", () => {
    const r = evaluateWakeupDispatch({ estimatedTokens: heavy, burnBudget: healthy, inflight: true });
    expect(r.verdict).toBe(DISPATCH_VERDICT_ALLOW);
    expect(r.reason).toBe("inflight_heavy_under_budget");
  });
});

import { describe, expect, it } from "vitest";
import {
  annotateContextSnapshot,
  evaluateDispatch,
  evaluateInflightHeavyDispatch,
  isHeavyDispatch,
} from "./fleet-dispatch-guard.js";
import type { BurnBudgetState } from "./agent-burn-budget.js";
import {
  DEMOTE_POLICY,
  DISPATCH_VERDICT_ALLOW,
  DISPATCH_VERDICT_ALLOW_DEMOTED,
  DISPATCH_VERDICT_BLOCK,
  HEAVY_DISPATCH_TOKEN_THRESHOLD,
} from "./fleet-throttle-constants.js";

function makeBudget(overrides: Partial<BurnBudgetState> = {}): BurnBudgetState {
  return {
    agentId: "agent-1",
    ceilingTokens: 1_100_000,
    consumedTokens: 0,
    remainingTokens: 1_100_000,
    remainingPctOfCeiling: 1,
    tripped: false,
    windowStart: new Date("2026-09-11T00:00:00.000Z"),
    windowEnd: new Date("2026-09-11T05:00:00.000Z"),
    ...overrides,
  };
}

describe("L5 — fleet-dispatch guard (verdict matrix)", () => {
  it("non-heavy + not tripped → allow", () => {
    const r = evaluateDispatch({
      estimatedTokens: 1_000,
      burnBudget: makeBudget({ tripped: false }),
    });
    expect(r.verdict).toBe(DISPATCH_VERDICT_ALLOW);
    expect(r.blocked).toBe(false);
    expect(r.reason).toBe("non_heavy");
  });

  it("heavy + not tripped → allow", () => {
    const r = evaluateDispatch({
      estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD + 1,
      burnBudget: makeBudget({ tripped: false, remainingPctOfCeiling: 0.6 }),
    });
    expect(r.verdict).toBe(DISPATCH_VERDICT_ALLOW);
    expect(r.blocked).toBe(false);
    expect(r.reason).toBe("heavy_under_budget");
  });

  it("heavy + tripped → block (TRIP_POLICY_BLOCK_NEW_HEAVY=true)", () => {
    const r = evaluateDispatch({
      estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD + 1,
      burnBudget: makeBudget({ tripped: true, remainingPctOfCeiling: 0.2 }),
    });
    expect(r.verdict).toBe(DISPATCH_VERDICT_BLOCK);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("fleet_cap_tripped");
  });

  it("heavy + tripped via forceHeavy → block", () => {
    const r = evaluateDispatch({
      forceHeavy: true,
      burnBudget: makeBudget({ tripped: true }),
    });
    expect(r.verdict).toBe(DISPATCH_VERDICT_BLOCK);
  });

  it("isHeavyDispatch respects HEAVY_DISPATCH_TOKEN_THRESHOLD boundary", () => {
    expect(isHeavyDispatch({ estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD - 1 })).toBe(false);
    expect(isHeavyDispatch({ estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD })).toBe(true);
    expect(isHeavyDispatch({ estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD + 1 })).toBe(true);
    expect(isHeavyDispatch({ forceHeavy: true })).toBe(true);
    expect(isHeavyDispatch({})).toBe(false);
  });
});

describe("L5 — in-flight heavy demote path (NFM-4695)", () => {
  it("heavy in-flight + not tripped → allow", () => {
    const r = evaluateInflightHeavyDispatch({
      burnBudget: makeBudget({ tripped: false, remainingPctOfCeiling: 0.5 }),
    });
    expect(r.verdict).toBe(DISPATCH_VERDICT_ALLOW);
    expect(r.blocked).toBe(false);
    expect(r.reason).toBe("inflight_heavy_under_budget");
  });

  it("heavy in-flight + tripped → allow_demoted (not block)", () => {
    const r = evaluateInflightHeavyDispatch({
      burnBudget: makeBudget({ tripped: true, remainingPctOfCeiling: 0.2 }),
    });
    expect(r.verdict).toBe(DISPATCH_VERDICT_ALLOW_DEMOTED);
    expect(r.blocked).toBe(false);
    expect(r.reason).toBe("fleet_cap_tripped");
  });
});

describe("L5 — annotateContextSnapshot", () => {
  it("adds fleet_dispatch block and dispatch.blocked:true on block verdict", () => {
    const r = evaluateDispatch({
      forceHeavy: true,
      burnBudget: makeBudget({ tripped: true, remainingPctOfCeiling: 0.2 }),
    });
    const annotated = annotateContextSnapshot({ existing: "kept" }, r, makeBudget({ tripped: true }));
    expect(annotated.existing).toBe("kept");
    expect((annotated.fleet_dispatch as { verdict: string }).verdict).toBe(DISPATCH_VERDICT_BLOCK);
    expect((annotated.fleet_dispatch as { blocked: boolean }).blocked).toBe(true);
    expect((annotated.dispatch as { blocked: boolean }).blocked).toBe(true);
    // NFM-4695 AC1: blocked → reviewOnly=true, reason="fleet_cap_tripped".
    expect(annotated.reviewOnly).toBe(true);
    expect(annotated.reason).toBe("fleet_cap_tripped");
  });

  it("annotates allow_demoted with reviewOnly=true + demotePolicy=read_only_review", () => {
    const r = evaluateInflightHeavyDispatch({
      burnBudget: makeBudget({ tripped: true, remainingPctOfCeiling: 0.2 }),
    });
    const annotated = annotateContextSnapshot({}, r, makeBudget({ tripped: true }));
    const fleet = annotated.fleet_dispatch as { verdict: string; demotePolicy: string | null };
    expect(fleet.verdict).toBe(DISPATCH_VERDICT_ALLOW_DEMOTED);
    expect(fleet.demotePolicy).toBe(DEMOTE_POLICY);
    expect(annotated.reviewOnly).toBe(true);
    expect(annotated.reason).toBe("fleet_cap_tripped");
  });

  it("does not set dispatch.blocked on non-block verdicts", () => {
    const r = evaluateDispatch({ estimatedTokens: 1, burnBudget: makeBudget() });
    const annotated = annotateContextSnapshot({}, r, makeBudget());
    expect(annotated.dispatch).toBeUndefined();
    expect((annotated.fleet_dispatch as { verdict: string }).verdict).toBe(DISPATCH_VERDICT_ALLOW);
  });
});
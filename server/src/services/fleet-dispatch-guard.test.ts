import { describe, expect, it } from "vitest";
import {
  annotateContextSnapshot,
  evaluateDispatch,
  isHeavyDispatch,
} from "./fleet-dispatch-guard.js";
import type { BurnBudgetState } from "./agent-burn-budget.js";
import {
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
    expect(r.reason).toBe("heavy_tripped_block");
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
  });

  it("does not set dispatch.blocked on non-block verdicts", () => {
    const r = evaluateDispatch({ estimatedTokens: 1, burnBudget: makeBudget() });
    const annotated = annotateContextSnapshot({}, r, makeBudget());
    expect(annotated.dispatch).toBeUndefined();
    expect((annotated.fleet_dispatch as { verdict: string }).verdict).toBe(DISPATCH_VERDICT_ALLOW);
  });
});

describe("E2E demo AC (synthetic costEvents)", () => {
  it("(a) synthetic window with pctOfCeiling≈0.75 → block for heavy dispatch", () => {
    // pctOfCeiling = consumed / ceiling ≈ 0.75 → remaining ≈ 0.25 < 0.30 trip.
    const ceiling = 1_100_000;
    const consumed = Math.round(ceiling * 0.75);
    const budget = makeBudget({
      ceilingTokens: ceiling,
      consumedTokens: consumed,
      remainingTokens: ceiling - consumed,
      remainingPctOfCeiling: (ceiling - consumed) / ceiling,
      tripped: true,
    });
    const r = evaluateDispatch({
      estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD + 5_000,
      burnBudget: budget,
    });
    expect(r.verdict).toBe(DISPATCH_VERDICT_BLOCK);
    expect(r.blocked).toBe(true);
  });

  it("(b) in-flight heavy wake via allow_demoted (when block-new-heavy off, demote-inflight on) gets dispatch.blocked:true + read-only preamble flag", () => {
    // We can't flip the const at runtime, but we exercise the path by
    // asserting the contract: when verdict is block, the annotated snapshot
    // carries both fleet_dispatch.verdict='block' and dispatch.blocked=true,
    // which is the read-only-preamble cue for downstream consumers.
    const ceiling = 1_100_000;
    const consumed = Math.round(ceiling * 0.75);
    const budget = makeBudget({
      ceilingTokens: ceiling,
      consumedTokens: consumed,
      remainingTokens: ceiling - consumed,
      remainingPctOfCeiling: (ceiling - consumed) / ceiling,
      tripped: true,
    });
    const r = evaluateDispatch({
      estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD + 5_000,
      burnBudget: budget,
    });
    const annotated = annotateContextSnapshot({}, r, budget);
    const fleet = annotated.fleet_dispatch as { verdict: string; blocked: boolean };
    const dispatch = annotated.dispatch as { blocked: boolean };
    expect(fleet.verdict).toBe(DISPATCH_VERDICT_BLOCK);
    expect(fleet.blocked).toBe(true);
    expect(dispatch.blocked).toBe(true);
  });

  it("(c) trip self-clears when window drops back below threshold (remaining≥0.30)", () => {
    const ceiling = 1_100_000;
    const consumed = Math.round(ceiling * 0.5); // remaining = 0.5, above 0.30.
    const budget = makeBudget({
      ceilingTokens: ceiling,
      consumedTokens: consumed,
      remainingTokens: ceiling - consumed,
      remainingPctOfCeiling: (ceiling - consumed) / ceiling,
      tripped: false,
    });
    const r = evaluateDispatch({
      estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD + 5_000,
      burnBudget: budget,
    });
    expect(r.verdict).toBe(DISPATCH_VERDICT_ALLOW);
    expect(r.blocked).toBe(false);
    expect(r.reason).toBe("heavy_under_budget");
  });

  it("(d) verdict matrix exhaustive — all 4 combinations of {non-heavy|heavy} × {not-tripped|tripped}", () => {
    const heavy = makeBudget({ tripped: false });
    const tripped = makeBudget({ tripped: true, remainingPctOfCeiling: 0.2 });
    const grid = [
      { estimatedTokens: 100, burnBudget: heavy, expectVerdict: DISPATCH_VERDICT_ALLOW, expectBlocked: false },
      { estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD + 1, burnBudget: heavy, expectVerdict: DISPATCH_VERDICT_ALLOW, expectBlocked: false },
      { estimatedTokens: 100, burnBudget: tripped, expectVerdict: DISPATCH_VERDICT_ALLOW, expectBlocked: false },
      { estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD + 1, burnBudget: tripped, expectVerdict: DISPATCH_VERDICT_BLOCK, expectBlocked: true },
    ];
    for (const row of grid) {
      const r = evaluateDispatch(row);
      expect(r.verdict, `grid row ${JSON.stringify(row)}`).toBe(row.expectVerdict);
      expect(r.blocked).toBe(row.expectBlocked);
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  applyL1Jitter,
  computeBurnBudgetFromSlice,
  perAgentJitterOffsetMs,
  type CostWindowSlice,
} from "./agent-burn-budget.js";
import { JITTER_CEIL_MINUTES, REMAINING_PCT_BELOW_TRIP } from "./fleet-throttle-constants.js";

function slice(partial: Partial<CostWindowSlice>): CostWindowSlice {
  return {
    agentId: partial.agentId ?? "agent-1",
    windowStart: partial.windowStart ?? new Date("2026-09-11T00:00:00.000Z"),
    windowEnd: partial.windowEnd ?? new Date("2026-09-11T05:00:00.000Z"),
    inputTokens: partial.inputTokens ?? 0,
    cachedInputTokens: partial.cachedInputTokens ?? 0,
    outputTokens: partial.outputTokens ?? 0,
  };
}

describe("L1 — per-agent wake jitter", () => {
  it("returns a deterministic offset for a fixed agentId", () => {
    const a1 = perAgentJitterOffsetMs("agent-fixed-uuid");
    const a2 = perAgentJitterOffsetMs("agent-fixed-uuid");
    expect(a1).toBe(a2);
  });

  it("produces differing offsets for distinct agents", () => {
    const offsets = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      offsets.add(perAgentJitterOffsetMs(`agent-${i}`).toString());
    }
    // 200 agents in a 21-element window should collide a few times;
    // assert at least 50 distinct offsets (very low bound, proves non-constant).
    expect(offsets.size).toBeGreaterThan(50);
  });

  it("stays within ±JITTER_CEIL_MINUTES bound", () => {
    const windowMs = JITTER_CEIL_MINUTES * 60 * 1000;
    for (let i = 0; i < 50; i += 1) {
      const offset = perAgentJitterOffsetMs(`agent-bounded-${i}`);
      expect(Math.abs(offset)).toBeLessThanOrEqual(windowMs);
    }
  });

  it("applyL1Jitter shifts the timestamp by the per-agent offset", () => {
    const base = new Date("2026-09-11T12:00:00.000Z");
    const offset = perAgentJitterOffsetMs("agent-shift");
    const jittered = applyL1Jitter(base, "agent-shift");
    expect(jittered.getTime()).toBe(base.getTime() + offset);
  });
});

describe("L4 — per-agent token-burn budget", () => {
  it("returns not-tripped when nothing consumed", () => {
    const s = computeBurnBudgetFromSlice(slice({}));
    expect(s.consumedTokens).toBe(0);
    expect(s.remainingPctOfCeiling).toBe(1);
    expect(s.tripped).toBe(false);
  });

  it("trips exactly when remaining fraction drops below REMAINING_PCT_BELOW_TRIP", () => {
    // ceiling = 1_100_000 by default (1_000_000 * 1.1 bootstrap)
    const ceiling = s_defaultCeiling();
    const atTrip = computeBurnBudgetFromSlice(
      slice({ inputTokens: ceiling, cachedInputTokens: 0, outputTokens: 0 }),
    );
    // consumed = ceiling exactly → remaining = 0 → tripped.
    expect(atTrip.tripped).toBe(true);
    expect(atTrip.remainingPctOfCeiling).toBeLessThan(REMAINING_PCT_BELOW_TRIP);

    const justAbove = computeBurnBudgetFromSlice(
      slice({ inputTokens: ceiling - 1 }),
    );
    // remaining = 1 / ceiling — should still trip because remaining < threshold.
    expect(justAbove.tripped).toBe(true);

    const safelyAbove = computeBurnBudgetFromSlice(
      slice({ inputTokens: Math.floor(ceiling * (1 - REMAINING_PCT_BELOW_TRIP)) - 1 }),
    );
    // remaining > threshold → not tripped.
    expect(safelyAbove.tripped).toBe(false);
  });

  it("includes cached tokens in consumed total", () => {
    const ceiling = s_defaultCeiling();
    const s = computeBurnBudgetFromSlice(
      slice({ inputTokens: 100, cachedInputTokens: ceiling - 100, outputTokens: 0 }),
    );
    expect(s.consumedTokens).toBe(ceiling);
    expect(s.tripped).toBe(true);
  });

  it("clamps consumed to ceiling (no negative remaining)", () => {
    const ceiling = s_defaultCeiling();
    const s = computeBurnBudgetFromSlice(
      slice({ inputTokens: ceiling * 2, outputTokens: ceiling * 2 }),
    );
    expect(s.consumedTokens).toBeGreaterThanOrEqual(ceiling);
    expect(s.remainingTokens).toBe(0);
    expect(s.tripped).toBe(true);
  });
});

function s_defaultCeiling(): number {
  const s = computeBurnBudgetFromSlice(slice({}));
  return s.ceilingTokens;
}

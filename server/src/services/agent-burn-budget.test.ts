import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyL1Jitter,
  computeBurnBudgetFromSlice,
  computeBurnBudgetTripState,
  perAgentJitterOffsetMs,
  type BurnBudgetTripState,
  type CostWindowSlice,
} from "./agent-burn-budget.js";
import {
  BURN_BUDGET_HYSTERESIS_TICKS,
  JITTER_CEIL_MINUTES,
  REMAINING_PCT_ABOVE_RECOVER,
  REMAINING_PCT_BELOW_TRIP,
  TEST_BURN_BUDGET_OVERRIDE_ENV,
} from "./fleet-throttle-constants.js";

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

describe("L4 — burn-budget trip state machine (hysteresis)", () => {
  const initial: BurnBudgetTripState = { tripped: false, consecutiveNormalTicks: 0, transitioned: false };

  it("trips immediately when remaining drops below REMAINING_PCT_BELOW_TRIP", () => {
    const next = computeBurnBudgetTripState(initial, 0.25);
    expect(next.tripped).toBe(true);
    expect(next.transitioned).toBe(true);
    expect(next.consecutiveNormalTicks).toBe(0);
  });

  it("holds previous state when reading lands in the hysteresis zone (0.30–0.35)", () => {
    const tripped: BurnBudgetTripState = { tripped: true, consecutiveNormalTicks: 0, transitioned: true };
    const mid = (REMAINING_PCT_BELOW_TRIP + REMAINING_PCT_ABOVE_RECOVER) / 2; // 0.325
    const next = computeBurnBudgetTripState(tripped, mid);
    expect(next.tripped).toBe(true);
    expect(next.transitioned).toBe(false);
  });

  it("recovers only after BURN_BUDGET_HYSTERESIS_TICKS consecutive readings ≥ REMAINING_PCT_ABOVE_RECOVER", () => {
    let state: BurnBudgetTripState = { tripped: true, consecutiveNormalTicks: 0, transitioned: true };
    for (let i = 1; i < BURN_BUDGET_HYSTERESIS_TICKS; i += 1) {
      state = computeBurnBudgetTripState(state, 0.5);
      expect(state.tripped).toBe(true);
      expect(state.transitioned).toBe(false);
      expect(state.consecutiveNormalTicks).toBe(i);
    }
    const recovered = computeBurnBudgetTripState(state, 0.5);
    expect(recovered.tripped).toBe(false);
    expect(recovered.transitioned).toBe(true);
  });

  it("oscillating 29% → 36% → 29% does not flap the demote flag", () => {
    // The headline AC for NFM-4695 hysteresis: a single recovered tick
    // must not clear the trip, and a return to the trip band must not
    // produce a flapping transition pair.
    let state: BurnBudgetTripState = initial;
    state = computeBurnBudgetTripState(state, 0.29);
    expect(state.tripped).toBe(true);
    state = computeBurnBudgetTripState(state, 0.36);
    expect(state.tripped).toBe(true); // still tripped — only 1 normal tick
    state = computeBurnBudgetTripState(state, 0.29);
    expect(state.tripped).toBe(true);
    expect(state.transitioned).toBe(false); // already tripped on tick 1
  });

  it("in-zone reading while not-tripped stays not-tripped (no false trip)", () => {
    let state = initial;
    const mid = (REMAINING_PCT_BELOW_TRIP + REMAINING_PCT_ABOVE_RECOVER) / 2;
    state = computeBurnBudgetTripState(state, mid);
    expect(state.tripped).toBe(false);
    expect(state.transitioned).toBe(false);
  });

  it("exact-boundary readings: 0.30 stays, 0.35 starts recovery counter", () => {
    let state: BurnBudgetTripState = { tripped: true, consecutiveNormalTicks: 0, transitioned: true };
    // 0.30 is in zone (>= 0.30 and < 0.35) — hold.
    state = computeBurnBudgetTripState(state, REMAINING_PCT_BELOW_TRIP);
    expect(state.tripped).toBe(true);
    expect(state.consecutiveNormalTicks).toBe(0); // in-zone resets counter
    // 0.35 starts recovery counter.
    state = computeBurnBudgetTripState(state, REMAINING_PCT_ABOVE_RECOVER);
    expect(state.tripped).toBe(true);
    expect(state.consecutiveNormalTicks).toBe(1);
  });
});

describe("L4 — env-flag test seam (NFM-4695 demo)", () => {
  const ORIGINAL_ENV = process.env[TEST_BURN_BUDGET_OVERRIDE_ENV];

  beforeEach(() => {
    delete process.env[TEST_BURN_BUDGET_OVERRIDE_ENV];
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env[TEST_BURN_BUDGET_OVERRIDE_ENV];
    } else {
      process.env[TEST_BURN_BUDGET_OVERRIDE_ENV] = ORIGINAL_ENV;
    }
  });

  it("env flag unset → readBurnBudgetForAgent reads costEvents (no override)", async () => {
    const { readBurnBudgetForAgent } = await import("./agent-burn-budget.js");
    // A db stub that returns a sum matching the test slice — the override
    // seam must NOT short-circuit when the env flag is unset.
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: async () => [
            { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0 },
          ],
        }),
      }),
    } as unknown as Parameters<typeof readBurnBudgetForAgent>[0];
    const result = await readBurnBudgetForAgent(fakeDb, "agent-env-off");
    expect(result.consumedTokens).toBe(100);
    expect(result.tripped).toBe(false);
  });

  it("env flag set to 0.25 → returns synthetic state with remainingPctOfCeiling=0.25, tripped=true", async () => {
    process.env[TEST_BURN_BUDGET_OVERRIDE_ENV] = "0.25";
    const { readBurnBudgetForAgent } = await import("./agent-burn-budget.js");
    // db is irrelevant when override is set, but the call site still passes one.
    const fakeDb = {} as Parameters<typeof readBurnBudgetForAgent>[0];
    const result = await readBurnBudgetForAgent(fakeDb, "agent-tripped");
    expect(result.remainingPctOfCeiling).toBe(0.25);
    expect(result.tripped).toBe(true);
    expect(result.ceilingTokens).toBeGreaterThan(0);
    expect(result.consumedTokens).toBeGreaterThan(0);
    expect(result.windowStart).toBeInstanceOf(Date);
    expect(result.windowEnd).toBeInstanceOf(Date);
  });

  it("env flag set to 0.36 (recovery zone) → tripped=false (stateless raw check)", async () => {
    process.env[TEST_BURN_BUDGET_OVERRIDE_ENV] = "0.36";
    const { readBurnBudgetForAgent } = await import("./agent-burn-budget.js");
    const fakeDb = {} as Parameters<typeof readBurnBudgetForAgent>[0];
    const result = await readBurnBudgetForAgent(fakeDb, "agent-recovered");
    expect(result.remainingPctOfCeiling).toBe(0.36);
    expect(result.tripped).toBe(false); // raw stateless flag at 36%
  });

  it("env flag set to invalid value → ignored (seam is no-op)", async () => {
    process.env[TEST_BURN_BUDGET_OVERRIDE_ENV] = "not-a-number";
    const { readBurnBudgetForAgent } = await import("./agent-burn-budget.js");
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: async () => [{ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }],
        }),
      }),
    } as unknown as Parameters<typeof readBurnBudgetForAgent>[0];
    const result = await readBurnBudgetForAgent(fakeDb, "agent-invalid");
    expect(result.remainingPctOfCeiling).toBe(1); // default zero-consumed
    expect(result.tripped).toBe(false);
  });

  it("env flag out of [0, 1] → ignored (seam is no-op)", async () => {
    process.env[TEST_BURN_BUDGET_OVERRIDE_ENV] = "1.5";
    const { readBurnBudgetForAgent } = await import("./agent-burn-budget.js");
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: async () => [{ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }],
        }),
      }),
    } as unknown as Parameters<typeof readBurnBudgetForAgent>[0];
    const result = await readBurnBudgetForAgent(fakeDb, "agent-oob");
    expect(result.remainingPctOfCeiling).toBe(1);
  });
});

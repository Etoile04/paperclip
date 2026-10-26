import { describe, expect, it } from "vitest";
import {
  AUTH_RECOVERY_MAX_ATTEMPTS_PER_AGENT,
  AUTH_RECOVERY_MAX_WAKES_PER_EPISODE,
  AUTH_RECOVERY_RETRY_SPACING_MS,
  buildRecoveryAnnotation,
  decideEpisodeOnAuthFailure,
  decideEpisodeOnGreen,
  decideEnrollmentRetry,
  nextRetryDueAt,
  planEpisodeReenrollments,
  shouldCloseEpisode,
  type LatchEvidence,
} from "./policy.js";

const T0 = "2026-10-26T09:00:00.000Z";
const GREEN = "2026-10-26T09:40:00.000Z";

function latch(overrides: Partial<LatchEvidence> & { agentId: string }): LatchEvidence {
  return {
    firstLatchedAt: T0,
    isStillLatched: true,
    hasSuccessfulRunSinceEpisodeStart: false,
    alreadyEnrolledAttempts: 0,
    ...overrides,
  };
}

describe("episode state transitions (AC3: green observation is the only trigger)", () => {
  it("opens a red episode on the first auth failure and only records afterwards", () => {
    expect(decideEpisodeOnAuthFailure(null)).toEqual({ action: "open" });
    expect(decideEpisodeOnAuthFailure({ id: "e1", state: "red" })).toEqual({ action: "noop" });
  });

  it("pauses retry firing when the provider re-breaks mid-recovery", () => {
    expect(decideEpisodeOnAuthFailure({ id: "e1", state: "recovering" })).toEqual({ action: "pause" });
  });

  it("never recovers without an open red episode", () => {
    expect(decideEpisodeOnGreen(null)).toEqual({ action: "noop" });
    expect(decideEpisodeOnGreen({ id: "e1", state: "recovering" })).toEqual({ action: "noop" });
    expect(decideEpisodeOnGreen({ id: "e1", state: "closed" })).toEqual({ action: "noop" });
    expect(decideEpisodeOnGreen({ id: "e1", state: "red" })).toEqual({ action: "recover" });
  });
});

describe("planEpisodeReenrollments (AC1 eligibility, AC2 bounds)", () => {
  it("re-enqueues only agents still latched with no success since episode start", () => {
    const plan = planEpisodeReenrollments({
      evidence: [
        latch({ agentId: "a", firstLatchedAt: "2026-10-26T09:00:00.000Z" }),
        latch({
          agentId: "b",
          firstLatchedAt: "2026-10-26T09:01:00.000Z",
          hasSuccessfulRunSinceEpisodeStart: true,
        }),
        latch({ agentId: "c", firstLatchedAt: "2026-10-26T09:02:00.000Z" }),
      ],
      wakesUsed: 0,
      now: GREEN,
    });
    expect(plan.recovered).toEqual(["b"]);
    expect(plan.reenqueued.map((item) => item.agentId)).toEqual(["a", "c"]);
    expect(plan.manual).toEqual([]);
    expect(plan.reenqueued.every((item) => item.attempt === 1)).toBe(true);
  });

  it("orders re-enqueues deterministically by first latch time then agent id", () => {
    const plan = planEpisodeReenrollments({
      evidence: [
        latch({ agentId: "z", firstLatchedAt: "2026-10-26T09:02:00.000Z" }),
        latch({ agentId: "m", firstLatchedAt: "2026-10-26T09:01:00.000Z" }),
        latch({ agentId: "a", firstLatchedAt: "2026-10-26T09:02:00.000Z" }),
      ],
      wakesUsed: 0,
      now: GREEN,
    });
    expect(plan.reenqueued.map((item) => item.agentId)).toEqual(["m", "a", "z"]);
  });

  it("keeps duplicate latch evidence collapsed to one wake per agent", () => {
    const plan = planEpisodeReenrollments({
      evidence: [
        latch({ agentId: "a", firstLatchedAt: "2026-10-26T09:00:00.000Z" }),
        latch({ agentId: "a", firstLatchedAt: "2026-10-26T09:00:30.000Z" }),
      ],
      wakesUsed: 0,
      now: GREEN,
    });
    expect(plan.reenqueued).toHaveLength(1);
  });

  it("enforces the per-episode wake cap and routes the overflow to manual", () => {
    const evidence = Array.from({ length: 25 }, (_, index) =>
      latch({
        agentId: `agent-${String(index).padStart(2, "0")}`,
        firstLatchedAt: new Date(Date.parse(T0) + index * 1000).toISOString(),
      }),
    );
    const plan = planEpisodeReenrollments({ evidence, wakesUsed: 0, now: GREEN });
    expect(plan.reenqueued).toHaveLength(AUTH_RECOVERY_MAX_WAKES_PER_EPISODE);
    expect(plan.manual).toHaveLength(5);
    expect(plan.manual[0]).toBe("agent-20");
  });

  it("does not wake an agent that already burned its attempt budget", () => {
    const plan = planEpisodeReenrollments({
      evidence: [
        latch({ agentId: "a", alreadyEnrolledAttempts: AUTH_RECOVERY_MAX_ATTEMPTS_PER_AGENT }),
        latch({ agentId: "b" }),
      ],
      wakesUsed: 0,
      now: GREEN,
    });
    expect(plan.exhausted).toEqual(["a"]);
    expect(plan.reenqueued.map((item) => item.agentId)).toEqual(["b"]);
  });

  it("holds retry attempts to the 10-minute spacing even when a re-green lands early", () => {
    const plan = planEpisodeReenrollments({
      evidence: [
        latch({
          agentId: "early",
          alreadyEnrolledAttempts: 1,
          lastWakeAt: "2026-10-26T09:35:00.000Z",
        }),
        latch({ agentId: "fresh" }),
      ],
      wakesUsed: 0,
      now: GREEN,
    });
    // "fresh" is a first wake (no spacing constraint); "early" just woke
    // 5 minutes ago and must wait for the sweep instead.
    expect(plan.reenqueued.map((item) => item.agentId)).toEqual(["fresh"]);
    expect(plan.waiting).toEqual(["early"]);
  });

  it("releases a spaced-out retry once the 10 minutes have elapsed", () => {
    const plan = planEpisodeReenrollments({
      evidence: [
        latch({
          agentId: "early",
          alreadyEnrolledAttempts: 1,
          lastWakeAt: "2026-10-26T09:35:00.000Z",
        }),
      ],
      wakesUsed: 0,
      now: "2026-10-26T09:45:00.000Z",
    });
    expect(plan.reenqueued.map((item) => item.agentId)).toEqual(["early"]);
    expect(plan.waiting).toEqual([]);
  });
});

describe("retry bounds (AC2: 3 attempts, 10 minutes apart, stop on success, capped per episode)", () => {
  const dueEnrollment = {
    state: "reenqueued" as const,
    attempts: 1,
    lastWakeAt: GREEN,
  };

  it("schedules the next wake no earlier than 10 minutes after the last", () => {
    expect(nextRetryDueAt(GREEN)).toBe("2026-10-26T09:50:00.000Z");
    expect(AUTH_RECOVERY_RETRY_SPACING_MS).toBe(10 * 60 * 1000);
  });

  it("waits while the next attempt is not yet due", () => {
    const decision = decideEnrollmentRetry({
      enrollment: dueEnrollment,
      isStillLatched: true,
      hasSuccessfulRunSinceEpisodeStart: false,
      wakesUsed: 1,
      now: "2026-10-26T09:45:00.000Z",
    });
    expect(decision).toEqual({ action: "wait", dueAt: "2026-10-26T09:50:00.000Z" });
  });

  it("stops on success", () => {
    const decision = decideEnrollmentRetry({
      enrollment: dueEnrollment,
      isStillLatched: true,
      hasSuccessfulRunSinceEpisodeStart: true,
      wakesUsed: 1,
      now: "2026-10-26T09:55:00.000Z",
    });
    expect(decision).toEqual({ action: "mark_succeeded" });
  });

  it("marks an agent recovered when it left error without a run success", () => {
    const decision = decideEnrollmentRetry({
      enrollment: dueEnrollment,
      isStillLatched: false,
      hasSuccessfulRunSinceEpisodeStart: false,
      wakesUsed: 1,
      now: "2026-10-26T09:55:00.000Z",
    });
    expect(decision).toEqual({ action: "mark_succeeded" });
  });

  it("fires the next attempt when due, up to the attempt bound", () => {
    const decision = decideEnrollmentRetry({
      enrollment: dueEnrollment,
      isStillLatched: true,
      hasSuccessfulRunSinceEpisodeStart: false,
      wakesUsed: 1,
      now: "2026-10-26T09:55:00.000Z",
    });
    expect(decision).toEqual({ action: "wake", attempt: 2 });
  });

  it("exhausts after the third attempt", () => {
    const decision = decideEnrollmentRetry({
      enrollment: { ...dueEnrollment, attempts: AUTH_RECOVERY_MAX_ATTEMPTS_PER_AGENT },
      isStillLatched: true,
      hasSuccessfulRunSinceEpisodeStart: false,
      wakesUsed: 3,
      now: "2026-10-26T09:55:00.000Z",
    });
    expect(decision).toEqual({ action: "mark_exhausted" });
  });

  it("denies retries once the per-episode wake cap is spent", () => {
    const decision = decideEnrollmentRetry({
      enrollment: dueEnrollment,
      isStillLatched: true,
      hasSuccessfulRunSinceEpisodeStart: false,
      wakesUsed: AUTH_RECOVERY_MAX_WAKES_PER_EPISODE,
      now: "2026-10-26T09:55:00.000Z",
    });
    expect(decision).toEqual({ action: "mark_exhausted" });
  });

  it("leaves non-active enrollments alone", () => {
    for (const state of ["succeeded", "exhausted", "manual"] as const) {
      const decision = decideEnrollmentRetry({
        enrollment: { ...dueEnrollment, state },
        isStillLatched: true,
        hasSuccessfulRunSinceEpisodeStart: false,
        wakesUsed: 1,
        now: "2026-10-26T09:55:00.000Z",
      });
      expect(decision).toEqual({ action: "noop" });
    }
  });
});

describe("episode closure", () => {
  it("closes only when every enrollment is terminal", () => {
    expect(shouldCloseEpisode([
      { state: "succeeded" },
      { state: "exhausted" },
      { state: "manual" },
    ])).toBe(true);
    expect(shouldCloseEpisode([
      { state: "succeeded" },
      { state: "reenqueued" },
    ])).toBe(false);
    expect(shouldCloseEpisode([
      { state: "enrolled" },
    ])).toBe(false);
    expect(shouldCloseEpisode([])).toBe(true);
  });
});

describe("recovery annotation (AC4)", () => {
  it("renders the fleet counts operators read without DB access", () => {
    expect(buildRecoveryAnnotation({
      recoveredAt: GREEN,
      reenqueuedCount: 16,
      manualCount: 4,
    })).toBe(
      "auth recovered at 2026-10-26T09:40:00.000Z — 16 agents re-enqueued / 4 manual (wake cap 20/episode)",
    );
  });

  it("appends the per-agent disposition", () => {
    const base = {
      recoveredAt: GREEN,
      reenqueuedCount: 16,
      manualCount: 4,
    };
    expect(buildRecoveryAnnotation({
      ...base,
      agent: { disposition: "reenqueued", attempt: 2, maxAttempts: 3, nextAttemptAt: "2026-10-26T09:50:00.000Z" },
    })).toBe(
      "auth recovered at 2026-10-26T09:40:00.000Z — 16 agents re-enqueued / 4 manual (wake cap 20/episode); this agent: wake 2/3 enqueued, next retry after 2026-10-26T09:50:00.000Z",
    );
    expect(buildRecoveryAnnotation({
      ...base,
      agent: { disposition: "manual" },
    })).toBe(
      "auth recovered at 2026-10-26T09:40:00.000Z — 16 agents re-enqueued / 4 manual (wake cap 20/episode); this agent: manual — wake cap reached, needs a manual wake",
    );
    expect(buildRecoveryAnnotation({
      ...base,
      agent: { disposition: "exhausted", attempt: 3, maxAttempts: 3 },
    })).toBe(
      "auth recovered at 2026-10-26T09:40:00.000Z — 16 agents re-enqueued / 4 manual (wake cap 20/episode); this agent: 3/3 wakes did not produce a successful run — manual wake required",
    );
  });
});

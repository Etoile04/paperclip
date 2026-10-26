import { describe, expect, it } from "vitest";
import {
  AUTH_RECOVERY_MAX_WAKES_PER_EPISODE,
  type EnrollmentState,
} from "../domain/policy.js";
import type {
  AuthRecoveryEnrollmentRow,
  AuthRecoveryEpisodeRow,
  AuthRecoveryStore,
  AuthRecoveryWakeEnqueuer,
} from "./ports.js";
import { createAuthRecoveryService } from "./use-cases.js";

const T0 = "2026-10-26T09:00:00.000Z";

type FakeRun = {
  agentId: string;
  status: "failed" | "succeeded";
  errorCode: string | null;
  finishedAt: string;
};

type FakeAgent = { id: string; status: string };

function createFakeStore(companyId: string) {
  const episodes: AuthRecoveryEpisodeRow[] = [];
  const enrollments = new Map<string, AuthRecoveryEnrollmentRow[]>();
  const errorReasons = new Map<string, string>();
  let runs: FakeRun[] = [];
  let agents: FakeAgent[] = [];
  let seq = 0;

  function freshEnrollment(agentId: string): AuthRecoveryEnrollmentRow {
    return {
      episodeId: "",
      agentId,
      state: "enrolled",
      attempts: 0,
      firstLatchedAt: T0,
      firstLatchedRunId: null,
      lastWakeAt: null,
      nextAttemptAt: null,
      resolvedAt: null,
    };
  }

  const store: AuthRecoveryStore = {
    async getActiveEpisode() {
      return episodes.find((episode) => episode.state !== "closed") ?? null;
    },
    async insertEpisode(_companyId, input) {
      seq += 1;
      const episode: AuthRecoveryEpisodeRow = {
        id: `episode-${seq}`,
        companyId,
        state: "red",
        startedAt: input.startedAt,
        firstGreenAt: null,
        firstGreenRunId: null,
        greenSource: null,
        wakesUsed: 0,
        reenqueuedCount: 0,
        manualCount: 0,
      };
      episodes.push(episode);
      enrollments.set(episode.id, []);
      return episode;
    },
    async markEpisodeRecovering(episodeId, input) {
      const episode = episodes.find((row) => row.id === episodeId)!;
      episodes.splice(episodes.indexOf(episode), 1, {
        ...episode,
        state: "recovering",
        firstGreenAt: input.greenAt,
        firstGreenRunId: input.greenRunId,
        greenSource: input.greenSource,
      });
    },
    async markEpisodeRed(episodeId) {
      const episode = episodes.find((row) => row.id === episodeId)!;
      episodes.splice(episodes.indexOf(episode), 1, { ...episode, state: "red" });
    },
    async markEpisodeClosed(episodeId, closedAt) {
      const episode = episodes.find((row) => row.id === episodeId)!;
      episodes.splice(episodes.indexOf(episode), 1, { ...episode, state: "closed" });
      void closedAt;
    },
    async addEpisodeWakes(episodeId, count) {
      const episode = episodes.find((row) => row.id === episodeId)!;
      episodes.splice(episodes.indexOf(episode), 1, {
        ...episode,
        wakesUsed: episode.wakesUsed + count,
      });
    },
    async setEpisodeCounts(episodeId, input) {
      const episode = episodes.find((row) => row.id === episodeId)!;
      episodes.splice(episodes.indexOf(episode), 1, {
        ...episode,
        reenqueuedCount: input.reenqueuedCount,
        manualCount: input.manualCount,
      });
    },
    async listLatchEvidence(_companyId, since) {
      const byAgent = new Map<string, { firstLatchedAt: string; runId: string | null }>();
      for (const run of runs) {
        if (run.status !== "failed" || run.errorCode !== "claude_auth_required") continue;
        if (Date.parse(run.finishedAt) < Date.parse(since)) continue;
        const existing = byAgent.get(run.agentId);
        if (!existing) {
          byAgent.set(run.agentId, { firstLatchedAt: run.finishedAt, runId: null });
        } else if (Date.parse(run.finishedAt) < Date.parse(existing.firstLatchedAt)) {
          byAgent.set(run.agentId, { firstLatchedAt: run.finishedAt, runId: existing.runId });
        }
      }
      return [...byAgent.entries()].map(([agentId, evidence]) => ({
        agentId,
        firstLatchedAt: evidence.firstLatchedAt,
        firstLatchedRunId: evidence.runId,
        isStillLatched: agents.find((agent) => agent.id === agentId)?.status === "error",
      }));
    },
    async listAgentsSucceededSince(_companyId, since) {
      return [...new Set(
        runs
          .filter((run) => run.status === "succeeded" && Date.parse(run.finishedAt) >= Date.parse(since))
          .map((run) => run.agentId),
      )];
    },
    async agentHasSuccessSince(_companyId, agentId, since) {
      return runs.some(
        (run) =>
          run.agentId === agentId &&
          run.status === "succeeded" &&
          Date.parse(run.finishedAt) >= Date.parse(since),
      );
    },
    async isAgentStillLatched(_companyId, agentId) {
      return agents.find((agent) => agent.id === agentId)?.status === "error";
    },
    async upsertEnrollments(episodeId, _companyId, rows) {
      const current = enrollments.get(episodeId) ?? [];
      const next = [...current];
      for (const row of rows) {
        const existing = next.find((enrollment) => enrollment.agentId === row.agentId);
        if (existing) {
          next.splice(next.indexOf(existing), 1, {
            ...existing,
            state: row.state,
            firstLatchedAt: existing.firstLatchedAt || row.firstLatchedAt,
            firstLatchedRunId: existing.firstLatchedRunId ?? row.firstLatchedRunId,
          });
        } else {
          next.push({
            ...freshEnrollment(row.agentId),
            episodeId,
            state: row.state,
            firstLatchedAt: row.firstLatchedAt,
            firstLatchedRunId: row.firstLatchedRunId,
          });
        }
      }
      enrollments.set(episodeId, next);
    },
    async listEnrollments(episodeId) {
      return (enrollments.get(episodeId) ?? []).map((enrollment) => ({ ...enrollment }));
    },
    async claimRetry(episodeId, agentId, expectedAttempts, input) {
      const current = enrollments.get(episodeId) ?? [];
      const enrollment = current.find((row) => row.agentId === agentId);
      if (!enrollment || enrollment.attempts !== expectedAttempts) return false;
      const next: AuthRecoveryEnrollmentRow = {
        ...enrollment,
        attempts: enrollment.attempts + 1,
        lastWakeAt: input.lastWakeAt,
        nextAttemptAt: input.nextAttemptAt,
      };
      current.splice(current.indexOf(enrollment), 1, next);
      return true;
    },
    async markEnrollment(episodeId, agentId, state, input) {
      const current = enrollments.get(episodeId) ?? [];
      const enrollment = current.find((row) => row.agentId === agentId);
      if (!enrollment) return;
      const next: AuthRecoveryEnrollmentRow = {
        ...enrollment,
        state: state as EnrollmentState,
        resolvedAt: input?.resolvedAt ?? enrollment.resolvedAt,
      };
      current.splice(current.indexOf(enrollment), 1, next);
    },
    async setAgentErrorReason(agentId, reason) {
      errorReasons.set(agentId, reason);
    },
  };

  return {
    store,
    seedRuns(next: FakeRun[]) {
      runs = next;
    },
    seedAgents(next: FakeAgent[]) {
      agents = next;
    },
    episodes,
    errorReasons,
  };
}

function createFakeEnqueuer() {
  const calls: Array<{ agentId: string; episodeId: string; attempt: number; idempotencyKey: string }> = [];
  const enqueuer: AuthRecoveryWakeEnqueuer = {
    async enqueueAuthRecoveryWake(input) {
      calls.push({ ...input });
      return null;
    },
  };
  return { enqueuer, calls };
}

function latchedRun(agentId: string, finishedAt: string): FakeRun {
  return { agentId, status: "failed", errorCode: "claude_auth_required", finishedAt };
}

function successRun(agentId: string, finishedAt: string): FakeRun {
  return { agentId, status: "succeeded", errorCode: null, finishedAt };
}

describe("createAuthRecoveryService", () => {
  it("re-enqueues only still-latched agents and collapses duplicate latches (AC1)", async () => {
    const fake = createFakeStore("company-1");
    const { enqueuer, calls } = createFakeEnqueuer();
    const service = createAuthRecoveryService(fake.store, enqueuer);
    fake.seedAgents([
      { id: "agent-a", status: "error" },
      { id: "agent-b", status: "idle" },
      { id: "agent-c", status: "error" },
    ]);
    fake.seedRuns([
      latchedRun("agent-a", "2026-10-26T09:00:05.000Z"),
      latchedRun("agent-a", "2026-10-26T09:00:40.000Z"), // duplicate latch
      latchedRun("agent-b", "2026-10-26T09:01:00.000Z"),
      successRun("agent-b", "2026-10-26T09:30:00.000Z"), // recovered mid-episode
      latchedRun("agent-c", "2026-10-26T09:02:00.000Z"),
    ]);

    await service.observeAuthFailure("company-1", { at: "2026-10-26T09:00:05.000Z" });
    const green = await service.observeGreen("company-1", {
      at: "2026-10-26T09:40:00.000Z",
      runId: "run-green-1",
    });

    expect(green).toEqual({ woken: 2, manual: 0, recovered: 1 });
    expect(calls.map((call) => call.agentId).sort()).toEqual(["agent-a", "agent-c"]);
    expect(calls.filter((call) => call.agentId === "agent-a")).toHaveLength(1);
    expect(calls.every((call) => call.attempt === 1)).toBe(true);
  });

  it("never wakes from failures alone (AC3)", async () => {
    const fake = createFakeStore("company-1");
    const { enqueuer, calls } = createFakeEnqueuer();
    const service = createAuthRecoveryService(fake.store, enqueuer);
    fake.seedAgents([{ id: "agent-a", status: "error" }]);
    fake.seedRuns([latchedRun("agent-a", T0)]);

    await service.observeAuthFailure("company-1", { at: T0 });
    await service.observeAuthFailure("company-1", { at: "2026-10-26T09:05:00.000Z" });
    expect(fake.episodes).toHaveLength(1);
    expect(fake.episodes[0]?.state).toBe("red");
    expect(calls).toHaveLength(0);
  });

  it("ignores green when no red episode exists (AC3)", async () => {
    const fake = createFakeStore("company-1");
    const { enqueuer, calls } = createFakeEnqueuer();
    const service = createAuthRecoveryService(fake.store, enqueuer);
    fake.seedAgents([{ id: "agent-a", status: "idle" }]);
    fake.seedRuns([successRun("agent-a", T0)]);

    const noEpisode = await service.observeGreen("company-1", { at: "2026-10-26T09:10:00.000Z" });
    expect(noEpisode).toEqual({ woken: 0, manual: 0, recovered: 0 });
    expect(fake.episodes).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("pauses retries while the provider is red again and resumes on the next green (AC3)", async () => {
    const fake = createFakeStore("company-1");
    const { enqueuer, calls } = createFakeEnqueuer();
    const service = createAuthRecoveryService(fake.store, enqueuer);
    fake.seedAgents([{ id: "agent-a", status: "error" }]);
    fake.seedRuns([latchedRun("agent-a", T0)]);

    await service.observeAuthFailure("company-1", { at: T0 });
    await service.observeGreen("company-1", { at: "2026-10-26T09:10:00.000Z" });
    expect(calls).toHaveLength(1);

    // The re-enqueued wake's run fails again — provider re-broke.
    fake.seedRuns([
      ...fake.episodes.length >= 0 ? [] : [],
      latchedRun("agent-a", "2026-10-26T09:12:00.000Z"),
    ]);
    await service.observeAuthFailure("company-1", { at: "2026-10-26T09:12:00.000Z" });

    // Attempt 2 comes due after the 10-minute spacing, but the episode is red.
    const paused = await service.sweepRetries("company-1", { now: "2026-10-26T09:25:00.000Z" });
    expect(paused).toEqual({ fired: 0, succeeded: 0, exhausted: 0 });
    expect(calls).toHaveLength(1);

    // Provider greens again → the due retry fires.
    await service.observeGreen("company-1", { at: "2026-10-26T09:26:00.000Z" });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.attempt).toBe(2);
  });

  it("enforces the 20-wake episode cap on a 16-agent episode (AC2)", async () => {
    const fake = createFakeStore("company-1");
    const { enqueuer, calls } = createFakeEnqueuer();
    const service = createAuthRecoveryService(fake.store, enqueuer);
    const agentIds = Array.from({ length: 16 }, (_, index) => `agent-${String(index).padStart(2, "0")}`);
    fake.seedAgents(agentIds.map((id) => ({ id, status: "error" })));
    fake.seedRuns(agentIds.map((id, index) => latchedRun(id, new Date(Date.parse(T0) + index * 1000).toISOString())));

    await service.observeAuthFailure("company-1", { at: T0 });
    await service.observeGreen("company-1", { at: "2026-10-26T09:10:00.000Z" });
    expect(calls).toHaveLength(16);

    // Every re-enqueued run fails again; the provider recovers once more.
    fake.seedRuns([
      ...agentIds.map((id, index) => latchedRun(id, new Date(Date.parse("2026-10-26T09:11:00.000Z") + index * 1000).toISOString())),
    ]);
    await service.observeAuthFailure("company-1", { at: "2026-10-26T09:12:00.000Z" });
    await service.observeGreen("company-1", { at: "2026-10-26T09:25:00.000Z" });

    // Only 20 - 16 = 4 retry wakes fit the episode cap; the rest go manual.
    expect(calls).toHaveLength(AUTH_RECOVERY_MAX_WAKES_PER_EPISODE);
    const episode = fake.episodes[0];
    expect(episode?.manualCount).toBe(12);
    expect(episode?.reenqueuedCount).toBe(20);
  });

  it("stops retrying an agent once its re-enqueued run succeeds (AC2)", async () => {
    const fake = createFakeStore("company-1");
    const { enqueuer, calls } = createFakeEnqueuer();
    const service = createAuthRecoveryService(fake.store, enqueuer);
    fake.seedAgents([{ id: "agent-a", status: "error" }]);
    fake.seedRuns([latchedRun("agent-a", T0)]);

    await service.observeAuthFailure("company-1", { at: T0 });
    await service.observeGreen("company-1", { at: "2026-10-26T09:10:00.000Z" });
    expect(calls).toHaveLength(1);

    fake.seedAgents([{ id: "agent-a", status: "idle" }]);
    fake.seedRuns([
      latchedRun("agent-a", T0),
      successRun("agent-a", "2026-10-26T09:14:00.000Z"),
    ]);
    const sweep = await service.sweepRetries("company-1", { now: "2026-10-26T09:25:00.000Z" });
    expect(sweep).toEqual({ fired: 0, succeeded: 1, exhausted: 0 });
    expect(calls).toHaveLength(1);
  });

  it("exhausts an agent after three failed attempts and closes the episode when all are terminal", async () => {
    const fake = createFakeStore("company-1");
    const { enqueuer, calls } = createFakeEnqueuer();
    const service = createAuthRecoveryService(fake.store, enqueuer);
    fake.seedAgents([{ id: "agent-a", status: "error" }]);
    fake.seedRuns([latchedRun("agent-a", T0)]);

    await service.observeAuthFailure("company-1", { at: T0 });
    await service.observeGreen("company-1", { at: "2026-10-26T09:10:00.000Z" });

    // Attempts 2 and 3 fire on later sweeps after the spacing elapses.
    await service.sweepRetries("company-1", { now: "2026-10-26T09:21:00.000Z" });
    await service.sweepRetries("company-1", { now: "2026-10-26T09:32:00.000Z" });
    expect(calls.map((call) => call.attempt)).toEqual([1, 2, 3]);

    const final = await service.sweepRetries("company-1", { now: "2026-10-26T09:43:00.000Z" });
    expect(final).toEqual({ fired: 0, succeeded: 0, exhausted: 1 });
    expect(fake.episodes[0]?.state).toBe("closed");

    // A green after closure must not reopen or re-wake anything.
    const afterClose = await service.observeGreen("company-1", { at: "2026-10-26T09:50:00.000Z" });
    expect(afterClose).toEqual({ woken: 0, manual: 0, recovered: 0 });
    expect(calls).toHaveLength(3);
  });

  it("annotates the latched errorReason surface with fleet counts and disposition (AC4)", async () => {
    const fake = createFakeStore("company-1");
    const { enqueuer } = createFakeEnqueuer();
    const service = createAuthRecoveryService(fake.store, enqueuer);
    fake.seedAgents([
      { id: "agent-a", status: "error" },
      { id: "agent-c", status: "error" },
    ]);
    fake.seedRuns([
      latchedRun("agent-a", "2026-10-26T09:00:05.000Z"),
      latchedRun("agent-c", "2026-10-26T09:02:00.000Z"),
    ]);

    await service.observeAuthFailure("company-1", { at: "2026-10-26T09:00:05.000Z" });
    await service.observeGreen("company-1", { at: "2026-10-26T09:40:00.000Z" });

    for (const agentId of ["agent-a", "agent-c"]) {
      expect(fake.errorReasons.get(agentId)).toBe(
        "auth recovered at 2026-10-26T09:40:00.000Z — 2 agents re-enqueued / 0 manual (wake cap 20/episode)" +
        `; this agent: wake 1/3 enqueued, next retry after 2026-10-26T09:50:00.000Z`,
      );
    }
  });

  it("does not double-wake when a second green lands while already recovering", async () => {
    const fake = createFakeStore("company-1");
    const { enqueuer, calls } = createFakeEnqueuer();
    const service = createAuthRecoveryService(fake.store, enqueuer);
    fake.seedAgents([{ id: "agent-a", status: "error" }]);
    fake.seedRuns([latchedRun("agent-a", T0)]);

    await service.observeAuthFailure("company-1", { at: T0 });
    await service.observeGreen("company-1", { at: "2026-10-26T09:10:00.000Z" });
    await service.observeGreen("company-1", { at: "2026-10-26T09:10:05.000Z" });
    expect(calls).toHaveLength(1);
  });
});

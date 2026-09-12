import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged channel-severed evaluation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres channel-severed observability tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const STALE_RUN_EVALUATION_ORIGIN_KIND = "stale_active_run_evaluation";

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

async function setFileMtime(filePath: string, at: Date) {
  await utimes(filePath, at, at);
}

describeEmbeddedPostgres("channel severed + observability_lost watchdog classification", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let transcriptRoot: string;
  const childProcesses = new Set<ChildProcess>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-channel-severed-observability-");
    db = createDb(tempDb.connectionString);
    transcriptRoot = await mkdtemp(path.join(os.tmpdir(), "nfm4784-transcripts-"));
  }, 30_000);

  afterEach(async () => {
    for (const child of childProcesses) {
      child.kill("SIGKILL");
      childProcesses.delete(child);
    }
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    await rm(transcriptRoot, { recursive: true, force: true });
  });

  interface SeedRunInput {
    now: Date;
    ageMs: number;
    lastOutputAgeMs?: number | null;
    processPid?: number | null;
    outputChannelState?: "severed" | null;
    severedAt?: Date | null;
    severedReason?: string | null;
    transcriptPath?: string | null;
    agentStatus?: string;
  }

  async function seedRunFixture(opts: SeedRunInput) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const startedAt = new Date(opts.now.getTime() - opts.ageMs);
    const lastOutputAt =
      opts.lastOutputAgeMs === undefined || opts.lastOutputAgeMs === null
        ? null
        : new Date(opts.now.getTime() - opts.lastOutputAgeMs);

    await db.insert(companies).values({
      id: companyId,
      name: "Severed Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ReleaseEngineer",
      role: "engineer",
      status: opts.agentStatus ?? "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "issue_timer",
      payload: { issueId },
      status: "claimed",
      runId,
      requestedAt: startedAt,
      updatedAt: startedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      startedAt,
      processStartedAt: startedAt,
      processPid: opts.processPid ?? null,
      processGroupId: null,
      lastOutputAt,
      lastOutputSeq: lastOutputAt ? 668 : 0,
      lastOutputStream: lastOutputAt ? "stdout" : null,
      outputChannelState: opts.outputChannelState ?? null,
      severedAt: opts.severedAt ?? null,
      severedReason: opts.severedReason ?? null,
      transcriptPath: opts.transcriptPath ?? null,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_timer" },
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Production deploy rerun",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      originKind: "manual",
      executionRunId: runId,
      startedAt,
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    return { companyId, agentId, runId, issueId, issuePrefix };
  }

  async function channelSeveredEvents(runId: string) {
    return db
      .select()
      .from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.eventType, "channel_severed")))
      .orderBy(heartbeatRunEvents.seq);
  }

  async function evaluationIssuesForRun(runId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.originKind, STALE_RUN_EVALUATION_ORIGIN_KIND), eq(issues.originId, runId)));
  }

  // AC1 — adapter harness emits channel_severed exactly once on the
  // process-handle-lost path (in-memory handle gone, child pid alive).
  it("marks the output channel severed exactly once when the harness loses the in-memory process handle but the child is alive", async () => {
    const now = new Date("2026-09-12T06:00:00.000Z");
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(typeof child.pid).toBe("number");

    const { runId } = await seedRunFixture({
      now,
      ageMs: 3 * 60 * 60 * 1000,
      lastOutputAgeMs: 2 * 60 * 60 * 1000,
      processPid: child.pid ?? null,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reapOrphanedRuns();

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.outputChannelState).toBe("severed");
    expect(run?.severedAt).toBeTruthy();
    expect(run?.severedReason ?? "").toContain("process_handle_lost");

    const events = await channelSeveredEvents(runId);
    expect(events).toHaveLength(1);
    const payload = (events[0]?.payload ?? {}) as Record<string, unknown>;
    expect(payload.childPid).toBe(child.pid);
    expect(String(payload.reason ?? "")).toContain("process_handle_lost");
    expect(typeof payload.ts).toBe("string");

    // Second reap cycle must not duplicate the marker or the event.
    await heartbeat.reapOrphanedRuns();
    expect(await channelSeveredEvents(runId)).toHaveLength(1);
  });

  // AC2 — severed run classifies observability_lost: operator alert fires,
  // no destructive auto-action fires.
  it("classifies a severed silent run as observability_lost and never cancels it", async () => {
    const now = new Date("2026-09-12T06:00:00.000Z");
    const severedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const { companyId, runId, agentId } = await seedRunFixture({
      now,
      ageMs: 3 * 60 * 60 * 1000,
      lastOutputAgeMs: 2 * 60 * 60 * 1000,
      outputChannelState: "severed",
      severedAt,
      severedReason: "process_handle_lost",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(result.observabilityLost).toBe(1);

    const evaluations = await evaluationIssuesForRun(runId);
    expect(evaluations).toHaveLength(1);
    const evaluation = evaluations[0];
    expect(evaluation?.title).toContain("Observability lost");
    expect(evaluation?.description ?? "").toContain("observability_lost");
    expect(evaluation?.description ?? "").not.toContain("suspicious output silence");

    // No destructive auto-action: run untouched, no synthetic retry, agent not failed.
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    const retryRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(retryRuns).toHaveLength(0);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent?.status).not.toBe("error");
  });

  // AC3 — transcript-growth check on a channel-healthy silent run.
  it("withholds the silence alert for a channel-healthy silent run whose transcript is still growing", async () => {
    const now = new Date("2026-09-12T06:00:00.000Z");
    const transcriptDir = path.join(transcriptRoot, randomUUID());
    await mkdir(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, "session-abc.jsonl");
    // Last write 30 minutes ago — after the output channel went silent 2h ago.
    await writeFile(transcriptPath, JSON.stringify({ type: "assistant", text: "working" }) + "\n");
    await setFileMtime(transcriptPath, new Date(now.getTime() - 30 * 60 * 1000));

    const { companyId, runId } = await seedRunFixture({
      now,
      ageMs: 3 * 60 * 60 * 1000,
      lastOutputAgeMs: 2 * 60 * 60 * 1000,
      transcriptPath,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(result.withheldTranscriptGrowing).toBe(1);

    const evaluations = await evaluationIssuesForRun(runId);
    expect(evaluations).toHaveLength(0);
  });

  it("still alerts on a channel-healthy silent run whose transcript is static", async () => {
    const now = new Date("2026-09-12T06:00:00.000Z");
    const transcriptDir = path.join(transcriptRoot, randomUUID());
    await mkdir(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, "session-abc.jsonl");
    // Last write 3h ago — the transcript went static before the silence window.
    await writeFile(transcriptPath, JSON.stringify({ type: "assistant", text: "stalled" }) + "\n");
    await setFileMtime(transcriptPath, new Date(now.getTime() - 3 * 60 * 60 * 1000));

    const { companyId, runId } = await seedRunFixture({
      now,
      ageMs: 3 * 60 * 60 * 1000,
      lastOutputAgeMs: 2 * 60 * 60 * 1000,
      transcriptPath,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(result.created).toBe(1);

    const evaluations = await evaluationIssuesForRun(runId);
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.title).toContain("Review silent active run");
  });

  // AC4 — the watchdog reads the transcript path from the run record; no
  // inference. The persisted path deliberately lives outside any Claude
  // config-dir layout.
  it("uses the transcript path persisted on the run record, wherever it points", async () => {
    const now = new Date("2026-09-12T06:00:00.000Z");
    const customPath = path.join(transcriptRoot, randomUUID(), "arbitrary-liveness-file.jsonl");
    await mkdir(path.dirname(customPath), { recursive: true });
    await writeFile(customPath, "growing\n");
    await setFileMtime(customPath, new Date(now.getTime() - 5 * 60 * 1000));

    const { companyId, runId } = await seedRunFixture({
      now,
      ageMs: 3 * 60 * 60 * 1000,
      lastOutputAgeMs: 2 * 60 * 60 * 1000,
      transcriptPath: customPath,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(result.withheldTranscriptGrowing).toBe(1);
    expect(await evaluationIssuesForRun(runId)).toHaveLength(0);
  });

  // AC5 — end-to-end reproduction of run 90b20402: harness dies mid-run,
  // orphaned child keeps working, transcript grows.
  it("reproduces the severed-channel incident: no suspicious-silence alert, no cancel, operator alert carries observability_lost", async () => {
    const now = new Date("2026-09-12T06:00:00.000Z");
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(typeof child.pid).toBe("number");

    const transcriptDir = path.join(transcriptRoot, randomUUID());
    await mkdir(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, "session-90b20402.jsonl");
    // Output log froze at seq 668 two hours ago; the transcript last wrote then too.
    await writeFile(transcriptPath, JSON.stringify({ seq: 668, type: "assistant" }) + "\n");
    await setFileMtime(transcriptPath, new Date(now.getTime() - 2 * 60 * 60 * 1000));

    const { companyId, runId } = await seedRunFixture({
      now,
      ageMs: 3 * 60 * 60 * 1000,
      lastOutputAgeMs: 2 * 60 * 60 * 1000,
      processPid: child.pid ?? null,
      transcriptPath,
    });

    const heartbeat = heartbeatService(db);

    // Harness "died": no in-memory handle for this run. Reap detects the lost
    // handle with the child still alive and severs the channel.
    await heartbeat.reapOrphanedRuns();
    const runAfterReap = await heartbeat.getRun(runId);
    expect(runAfterReap?.outputChannelState).toBe("severed");
    expect(await channelSeveredEvents(runId)).toHaveLength(1);

    // The orphaned child keeps working productively: the transcript grows.
    await appendFile(transcriptPath, JSON.stringify({ type: "assistant", text: "still deploying" }) + "\n");
    await setFileMtime(transcriptPath, new Date(now.getTime() - 60 * 1000));

    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(result.created).toBe(0);
    expect(result.observabilityLost).toBe(1);

    const evaluations = await evaluationIssuesForRun(runId);
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.title).toContain("Observability lost");
    expect(evaluations[0]?.description ?? "").toContain("observability_lost");

    // No suspicious-silence alert exists anywhere for this run.
    const suspiciousEvaluations = evaluations.filter((issue) =>
      issue.title.includes("Review silent active run"),
    );
    expect(suspiciousEvaluations).toHaveLength(0);

    // No destructive action: the run is untouched and no synthetic retry exists.
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    const retryRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(retryRuns).toHaveLength(0);
  });

  // Terminal honesty — a severed run whose child is gone ends in
  // observability_lost, never a synthetic failure, and is never auto-retried.
  it("ends a severed run in observability_lost when the child is gone — no synthetic failure, no auto-retry", async () => {
    const now = new Date("2026-09-12T06:00:00.000Z");
    const { runId, agentId } = await seedRunFixture({
      now,
      ageMs: 3 * 60 * 60 * 1000,
      lastOutputAgeMs: 2 * 60 * 60 * 1000,
      processPid: 999_999_999,
      outputChannelState: "severed",
      severedAt: new Date(now.getTime() - 90 * 60 * 1000),
      severedReason: "process_handle_lost",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.reapOrphanedRuns();

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("observability_lost");
    expect(run?.errorCode).toBe("observability_lost");
    expect(run?.error ?? "").toContain("outcome unknown");

    const retryRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(retryRuns).toHaveLength(0);

    const [wakeup] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, runId));
    expect(wakeup?.status).toBe("failed");
    expect(wakeup?.error ?? "").toContain("observability_lost");

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent?.status).toBe("error");
    expect(agent?.errorReason ?? "").toContain("observability_lost");
  });

  // Safety invariant — absence of telemetry is never sufficient evidence for a
  // destructive action: a dead-pid force-fail defers while the transcript grows.
  it("defers the process_lost force-fail while the transcript is still advancing", async () => {
    // reapOrphanedRuns stamps from the real clock (unlike scanSilentActiveRuns,
    // which accepts an injected now), so the transcript mtimes must be relative
    // to Date.now() for the recency window to hold.
    const now = new Date();
    const transcriptDir = path.join(transcriptRoot, randomUUID());
    await mkdir(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, "session-defer.jsonl");
    await writeFile(transcriptPath, "baseline\n");
    await setFileMtime(transcriptPath, new Date(now.getTime() - 60 * 1000));

    const { runId } = await seedRunFixture({
      now,
      ageMs: 3 * 60 * 60 * 1000,
      lastOutputAgeMs: 2 * 60 * 60 * 1000,
      processPid: 999_999_999,
      transcriptPath,
    });

    const heartbeat = heartbeatService(db);

    // First cycle: the transcript wrote recently (within the silence window),
    // so the force-fail defers despite the dead pid.
    await heartbeat.reapOrphanedRuns();
    let run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.transcriptStatJson).toBeTruthy();

    // Transcript goes static (no further writes, mtime pinned in the past).
    await setFileMtime(transcriptPath, new Date(now.getTime() - 3 * 60 * 60 * 1000));

    // Second cycle: positive death evidence (pid gone) AND static transcript
    // now coexist — the existing process_lost behavior is restored.
    await heartbeat.reapOrphanedRuns();
    run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
  });
});

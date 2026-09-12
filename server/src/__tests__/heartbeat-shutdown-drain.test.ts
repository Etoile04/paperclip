import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySecretBindings,
  companySecrets,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  documentRevisions,
  documents,
  issueWorkProducts,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";

// Retry runs must finalize without spawning real adapter children: mock the
// adapter execute path (mirrors heartbeat-process-recovery.test.ts) while the
// process-termination path under test (runningProcesses + terminateLocalService)
// stays real so pid-exit assertions are meaningful.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Recovered detached heartbeat work.",
    provider: "test",
    model: "test-model",
  })),
);

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

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres shutdown drain tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

function isPidAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isPidAlive(pid);
}

async function deleteWithRetries(
  run: () => Promise<unknown>,
  attempts = 5,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await run();
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describeEmbeddedPostgres("heartbeat shutdown drain and detached run bounds", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ChildProcess>();
  const cleanupPids = new Set<number>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-drain-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();

    await db.delete(issueWorkProducts);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    // Async retry-run finalization can race table deletes; retry the FK roots.
    await deleteWithRetries(async () => {
      await db.delete(issues);
    });
    await deleteWithRetries(async () => {
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      await db.delete(environmentLeases);
      await db.delete(heartbeatRuns);
    });
    await db.delete(agentWakeupRequests);
    await deleteWithRetries(async () => {
      await db.delete(agentRuntimeState);
      await db.delete(environments);
      await db.delete(agents);
    });
    await deleteWithRetries(async () => {
      await db.delete(companySkills);
      await db.delete(workspaceOperations);
      await db.delete(executionWorkspaces);
      await db.delete(projectWorkspaces);
      await db.delete(projects);
      await db.delete(companySecretBindings);
      await db.delete(companySecrets);
      await db.delete(companies);
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedDetachedRunFixture(input?: { processLossRetryCount?: number }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-09-12T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: { issueId },
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      startedAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Bound detached run lifetime",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("terminates a detached run and queues one retry once the detached age bound is exceeded", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");
    cleanupPids.add(child.pid!);

    const { agentId, runId } = await seedDetachedRunFixture();
    await db
      .update(heartbeatRuns)
      .set({ processPid: child.pid })
      .where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatService(db);

    const firstReap = await heartbeat.reapOrphanedRuns();
    expect(firstReap.reaped).toBe(0);
    let run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");

    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondReap = await heartbeat.reapOrphanedRuns({ detachedMaxAgeMs: 5 });
    expect(secondReap.reaped).toBe(1);
    expect(secondReap.runIds).toEqual([runId]);

    expect(await waitForPidExit(child.pid!)).toBe(true);

    run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const retryRuns = runs.filter((row) => row.retryOfRunId === runId);
    expect(retryRuns).toHaveLength(1);
    expect(retryRuns[0]?.processLossRetryCount).toBe(1);
  });

  it("leaves a freshly detached run running while under the detached age bound", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    cleanupPids.add(child.pid!);

    const { runId } = await seedDetachedRunFixture();
    await db
      .update(heartbeatRuns)
      .set({ processPid: child.pid })
      .where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns({ detachedMaxAgeMs: 10 * 60_000 });
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(isPidAlive(child.pid)).toBe(true);
  });

  it("resets the detached age clock when the detached child reports activity", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    cleanupPids.add(child.pid!);

    const { runId } = await seedDetachedRunFixture();
    await db
      .update(heartbeatRuns)
      .set({ processPid: child.pid })
      .where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatService(db);

    await heartbeat.reapOrphanedRuns();
    await heartbeat.reportRunActivity(runId);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const result = await heartbeat.reapOrphanedRuns({ detachedMaxAgeMs: 5 });
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(isPidAlive(child.pid)).toBe(true);
  });

  it("never terminates a detached run when the detached age bound is disabled", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    cleanupPids.add(child.pid!);

    const { runId } = await seedDetachedRunFixture();
    await db
      .update(heartbeatRuns)
      .set({ processPid: child.pid })
      .where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatService(db);

    await heartbeat.reapOrphanedRuns();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const result = await heartbeat.reapOrphanedRuns({ detachedMaxAgeMs: 0 });
    expect(result.reaped).toBe(0);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(isPidAlive(child.pid)).toBe(true);
  });

  it("terminates tracked children, finalizes runs, and queues retries on shutdown drain", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");
    cleanupPids.add(child.pid!);

    const { agentId, runId } = await seedDetachedRunFixture();
    await db
      .update(heartbeatRuns)
      .set({ processPid: child.pid })
      .where(eq(heartbeatRuns.id, runId));
    runningProcesses.set(runId, { child, graceSec: 1, processGroupId: null });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.terminateActiveRunsForShutdown();
    expect(result.terminated).toEqual([runId]);

    expect(await waitForPidExit(child.pid!)).toBe(true);
    expect(runningProcesses.has(runId)).toBe(false);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
    expect(run?.error).toContain("Server shutdown");

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const retryRuns = runs.filter((row) => row.retryOfRunId === runId);
    expect(retryRuns).toHaveLength(1);
    expect(retryRuns[0]?.processLossRetryCount).toBe(1);

    const secondPass = await heartbeat.terminateActiveRunsForShutdown();
    expect(secondPass.terminated).toEqual([]);
  });
});

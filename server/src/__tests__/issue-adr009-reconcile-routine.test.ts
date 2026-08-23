import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ADR_009_RECONCILE_ROUTINE_FEATURE_FLAG,
  issueReconciliationService,
} from "../services/issue-reconciliation.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres ADR-009 reconcile routine tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const FIXED_NOW = new Date("2026-08-24T06:00:00.000Z");

describeEmbeddedPostgres("ADR-009 §4.3-a daily reconcile routine", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-adr009-reconcile-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(instanceSettings);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ── helpers ─────────────────────────────────────────────────────────────

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CoderBot",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(input: {
    companyId: string;
    status?: string;
    assigneeAgentId?: string | null;
    checkoutRunId?: string | null;
    identifier?: string;
  }): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: `Issue ${issueId.slice(0, 6)}`,
      status: input.status ?? "backlog",
      assigneeAgentId: input.assigneeAgentId ?? null,
      checkoutRunId: input.checkoutRunId ?? null,
      identifier: input.identifier ?? `T-${issueId.slice(0, 4)}`,
      originFingerprint: `fp-${issueId}`,
    });
    return issueId;
  }

  async function addBlocker(input: {
    companyId: string;
    blockerId: string;
    dependentId: string;
  }) {
    await db.insert(issueRelations).values({
      companyId: input.companyId,
      issueId: input.blockerId,
      relatedIssueId: input.dependentId,
      type: "blocks",
    });
  }

  async function seedHeartbeatRun(input: {
    companyId: string;
    agentId: string;
  }): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "running",
      startedAt: FIXED_NOW,
    });
    return runId;
  }

  async function enableFlag() {
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      experimental: {},
      general: {},
    });
    await db
      .update(instanceSettings)
      .set({
        experimental: { enableAdr009ReconcileRoutine: true },
      })
      .where(eq(instanceSettings.singletonKey, "default"));
  }

  async function readAuditEntries(): Promise<
    Array<{ action: string; entityId: string; details: Record<string, unknown> | null }>
  > {
    return db
      .select({
        action: activityLog.action,
        entityId: activityLog.entityId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.action, "issue_blockers_updated"))
      .then((rows) =>
        rows.map((row) => ({
          action: row.action,
          entityId: row.entityId,
          details: row.details,
        })),
      );
  }

  async function readIssue(id: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, id)).limit(1);
    return row ?? null;
  }

  // ── tests ───────────────────────────────────────────────────────────────

  it("returns a no-op result when the feature flag is disabled", async () => {
    const companyId = await seedCompany();
    const blocker = await seedIssue({ companyId, status: "done" });
    const dependent = await seedIssue({ companyId, status: "blocked" });
    await addBlocker({ companyId, blockerId: blocker, dependentId: dependent });

    // Flag stays at its default (false); don't seed the instanceSettings row.
    const result = await issueReconciliationService(db).reconcileIssueBlockersDaily({
      now: FIXED_NOW,
    });

    expect(result.skippedReason).toBe("flag-disabled");
    expect(result.companiesScanned).toBe(0);
    expect(result.dependentsTouched).toBe(0);
    expect(result.blockersRemoved).toBe(0);
    expect(result.auditEntriesWritten).toBe(0);
    expect(result.autoTransitionsFired).toBe(0);
    expect(result.wakesFired).toBe(0);

    // The blocker edge is untouched.
    const remaining = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.issueId, blocker),
          eq(issueRelations.relatedIssueId, dependent),
        ),
      );
    expect(remaining).toHaveLength(1);

    // No audit entries written.
    const audits = await readAuditEntries();
    expect(audits).toHaveLength(0);
  });

  it("is a no-op when nothing needs reconciling (idempotence guard)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    // All blockers are in non-terminal statuses — nothing to reconcile.
    const blockerActive = await seedIssue({ companyId, status: "in_progress" });
    const blockerTodo = await seedIssue({ companyId, status: "todo" });
    const dependent = await seedIssue({
      companyId,
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await addBlocker({ companyId, blockerId: blockerActive, dependentId: dependent });
    await addBlocker({ companyId, blockerId: blockerTodo, dependentId: dependent });

    await enableFlag();

    const result = await issueReconciliationService(db).reconcileIssueBlockersDaily({
      now: FIXED_NOW,
    });

    expect(result.skippedReason).toBeUndefined();
    expect(result.dependentsTouched).toBe(0);
    expect(result.blockersRemoved).toBe(0);
    expect(result.auditEntriesWritten).toBe(0);
    expect(result.autoTransitionsFired).toBe(0);
    expect(result.wakesFired).toBe(0);

    // Both edges still present.
    const edges = await db
      .select()
      .from(issueRelations)
      .where(eq(issueRelations.companyId, companyId));
    expect(edges).toHaveLength(2);

    const dependentAfter = await readIssue(dependent);
    expect(dependentAfter?.status).toBe("blocked");

    const audits = await readAuditEntries();
    expect(audits).toHaveLength(0);
  });

  it("removes a terminal blocker edge, logs §4.1 audit shape, and auto-transitions blocked → todo", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const blockerDone = await seedIssue({
      companyId,
      status: "done",
      identifier: "T-DONE",
    });
    const dependent = await seedIssue({
      companyId,
      status: "blocked",
      assigneeAgentId: agentId,
      identifier: "T-DEP",
    });
    await addBlocker({ companyId, blockerId: blockerDone, dependentId: dependent });

    await enableFlag();

    const wakeSpy = vi.fn(async () => null);

    const result = await issueReconciliationService(db).reconcileIssueBlockersDaily({
      now: FIXED_NOW,
      enqueueWakeup: wakeSpy,
    });

    expect(result.skippedReason).toBeUndefined();
    expect(result.companiesScanned).toBe(1);
    expect(result.dependentsTouched).toBe(1);
    expect(result.blockersRemoved).toBe(1);
    expect(result.auditEntriesWritten).toBe(1);
    expect(result.autoTransitionsFired).toBe(1);
    expect(result.wakesFired).toBe(1);

    // Edge was deleted.
    const remaining = await db
      .select()
      .from(issueRelations)
      .where(eq(issueRelations.companyId, companyId));
    expect(remaining).toHaveLength(0);

    // Dependent was auto-transitioned blocked → todo (no checkout).
    const dependentAfter = await readIssue(dependent);
    expect(dependentAfter?.status).toBe("todo");
    expect(dependentAfter?.startedAt).toBeNull();

    // Audit log: §4.1 shape, single entry per closing blocker.
    const audits = await readAuditEntries();
    expect(audits).toHaveLength(1);
    const entry = audits[0];
    expect(entry.action).toBe("issue_blockers_updated");
    expect(entry.entityId).toBe(dependent);

    const details = entry.details as Record<string, unknown>;
    expect(details.routine).toBe("adr009-daily-reconcile");
    expect(details.ts).toBe(FIXED_NOW.toISOString());
    expect(details.closing_issue_id).toBe(blockerDone);
    expect(details.closing_issue_identifier).toBe("T-DONE");
    expect(details.dependent_id).toBe(dependent);
    expect(details.dependent_identifier).toBe("T-DEP");
    expect(details.before_blockedByIssueIds).toEqual([blockerDone]);
    expect(details.after_blockedByIssueIds).toEqual([]);
    expect(details.status_transition).toEqual({ from: "blocked", to: "todo" });
    expect(details.feature_flag).toBe(ADR_009_RECONCILE_ROUTINE_FEATURE_FLAG);
    expect(details.wake_fired).toBe(true);

    // Wake was called exactly once for the assignee.
    expect(wakeSpy).toHaveBeenCalledTimes(1);
    expect(wakeSpy).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        source: "automation",
        reason: "issue_blockers_resolved",
        payload: expect.objectContaining({
          issueId: dependent,
          resolvedBlockerIssueIds: [blockerDone],
          viaRoutine: "adr009-daily-reconcile",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: dependent,
          source: "adr009-daily-reconcile",
          transition: { from: "blocked", to: "todo" },
        }),
      }),
    );
  });

  it("auto-transitions blocked → in_progress when dependent has a checkoutRunId and sets startedAt", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const blocker = await seedIssue({ companyId, status: "done" });
    const checkoutRunId = await seedHeartbeatRun({ companyId, agentId });
    const dependent = await seedIssue({
      companyId,
      status: "blocked",
      assigneeAgentId: agentId,
      checkoutRunId,
    });
    await addBlocker({ companyId, blockerId: blocker, dependentId: dependent });

    await enableFlag();

    const result = await issueReconciliationService(db).reconcileIssueBlockersDaily({
      now: FIXED_NOW,
    });

    expect(result.autoTransitionsFired).toBe(1);

    const dependentAfter = await readIssue(dependent);
    expect(dependentAfter?.status).toBe("in_progress");
    expect(dependentAfter?.startedAt?.toISOString()).toBe(FIXED_NOW.toISOString());

    const audits = await readAuditEntries();
    expect(audits).toHaveLength(1);
    const details = audits[0].details as Record<string, unknown>;
    expect(details.status_transition).toEqual({ from: "blocked", to: "in_progress" });
  });

  it("keeps dependents in `blocked` when at least one non-terminal blocker remains", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const blockerDone = await seedIssue({ companyId, status: "done" });
    const blockerActive = await seedIssue({ companyId, status: "in_progress" });
    const dependent = await seedIssue({
      companyId,
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await addBlocker({ companyId, blockerId: blockerDone, dependentId: dependent });
    await addBlocker({ companyId, blockerId: blockerActive, dependentId: dependent });

    await enableFlag();

    const result = await issueReconciliationService(db).reconcileIssueBlockersDaily({
      now: FIXED_NOW,
    });

    expect(result.dependentsTouched).toBe(1);
    expect(result.blockersRemoved).toBe(1);
    expect(result.autoTransitionsFired).toBe(0);
    expect(result.wakesFired).toBe(0);

    // Only the terminal-blocker edge was deleted; the active-blocker edge remains.
    const remaining = await db
      .select()
      .from(issueRelations)
      .where(eq(issueRelations.companyId, companyId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].issueId).toBe(blockerActive);

    const dependentAfter = await readIssue(dependent);
    expect(dependentAfter?.status).toBe("blocked");

    // One audit entry for the single closing blocker.
    const audits = await readAuditEntries();
    expect(audits).toHaveLength(1);
    const details = audits[0].details as Record<string, unknown>;
    expect(details.before_blockedByIssueIds).toEqual([blockerDone, blockerActive]);
    expect(details.after_blockedByIssueIds).toEqual([blockerActive]);
    expect(details.status_transition).toBeNull();
  });

  it("writes one audit entry per closing blocker when multiple blockers close in the same run", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const blockerA = await seedIssue({ companyId, status: "done", identifier: "T-A" });
    const blockerB = await seedIssue({ companyId, status: "cancelled", identifier: "T-B" });
    const blockerActive = await seedIssue({ companyId, status: "todo", identifier: "T-ACT" });
    const dependent = await seedIssue({
      companyId,
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await addBlocker({ companyId, blockerId: blockerA, dependentId: dependent });
    await addBlocker({ companyId, blockerId: blockerB, dependentId: dependent });
    await addBlocker({ companyId, blockerId: blockerActive, dependentId: dependent });

    await enableFlag();

    const result = await issueReconciliationService(db).reconcileIssueBlockersDaily({
      now: FIXED_NOW,
    });

    expect(result.dependentsTouched).toBe(1);
    expect(result.blockersRemoved).toBe(2);
    expect(result.auditEntriesWritten).toBe(2);
    expect(result.autoTransitionsFired).toBe(0);

    const audits = await readAuditEntries();
    expect(audits).toHaveLength(2);

    const closingIds = audits
      .map((a) => (a.details as Record<string, unknown>).closing_issue_id)
      .sort();
    expect(closingIds).toEqual([blockerA, blockerB].sort());

    // Each entry carries the full before/after lists so an operator can
    // reconstruct the dependent's state before vs. after this run.
    for (const audit of audits) {
      const details = audit.details as Record<string, unknown>;
      expect(details.before_blockedByIssueIds).toEqual(
        expect.arrayContaining([blockerA, blockerB, blockerActive]),
      );
      expect(details.after_blockedByIssueIds).toEqual([blockerActive]);
    }
  });

  it("treats a cancelled blocker the same as a done blocker", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const blockerCancelled = await seedIssue({ companyId, status: "cancelled" });
    const dependent = await seedIssue({
      companyId,
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await addBlocker({ companyId, blockerId: blockerCancelled, dependentId: dependent });

    await enableFlag();

    const wakeSpy = vi.fn(async () => null);

    const result = await issueReconciliationService(db).reconcileIssueBlockersDaily({
      now: FIXED_NOW,
      enqueueWakeup: wakeSpy,
    });

    expect(result.blockersRemoved).toBe(1);
    expect(result.autoTransitionsFired).toBe(1);
    expect(result.wakesFired).toBe(1);
    expect(wakeSpy).toHaveBeenCalledTimes(1);

    const dependentAfter = await readIssue(dependent);
    expect(dependentAfter?.status).toBe("todo");

    const audits = await readAuditEntries();
    expect(audits).toHaveLength(1);
    expect((audits[0].details as Record<string, unknown>).status_transition).toEqual({
      from: "blocked",
      to: "todo",
    });
    expect((audits[0].details as Record<string, unknown>).wake_fired).toBe(true);
  });

  it("does not fire a wake when the auto-transitioned dependent has no assignee", async () => {
    const companyId = await seedCompany();

    const blocker = await seedIssue({ companyId, status: "done" });
    const dependent = await seedIssue({
      companyId,
      status: "blocked",
      assigneeAgentId: null,
    });
    await addBlocker({ companyId, blockerId: blocker, dependentId: dependent });

    await enableFlag();

    const wakeSpy = vi.fn(async () => null);

    const result = await issueReconciliationService(db).reconcileIssueBlockersDaily({
      now: FIXED_NOW,
      enqueueWakeup: wakeSpy,
    });

    expect(result.autoTransitionsFired).toBe(1);
    expect(result.wakesFired).toBe(0);

    const dependentAfter = await readIssue(dependent);
    expect(dependentAfter?.status).toBe("todo");

    expect(wakeSpy).not.toHaveBeenCalled();

    const audits = await readAuditEntries();
    expect(audits).toHaveLength(1);
    expect((audits[0].details as Record<string, unknown>).wake_fired).toBe(false);
  });

  it("re-running on already-reconciled data is a no-op (idempotence guard)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const blocker = await seedIssue({ companyId, status: "done" });
    const dependent = await seedIssue({
      companyId,
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await addBlocker({ companyId, blockerId: blocker, dependentId: dependent });

    await enableFlag();

    const first = await issueReconciliationService(db).reconcileIssueBlockersDaily({
      now: FIXED_NOW,
    });
    expect(first.dependentsTouched).toBe(1);
    expect(first.blockersRemoved).toBe(1);

    const auditsAfterFirst = await readAuditEntries();
    expect(auditsAfterFirst).toHaveLength(1);
    const dependentAfterFirst = await readIssue(dependent);
    expect(dependentAfterFirst?.status).toBe("todo");

    // Second run on the same data — nothing left to reconcile.
    const second = await issueReconciliationService(db).reconcileIssueBlockersDaily({
      now: FIXED_NOW,
    });
    expect(second.dependentsTouched).toBe(0);
    expect(second.blockersRemoved).toBe(0);
    expect(second.auditEntriesWritten).toBe(0);
    expect(second.autoTransitionsFired).toBe(0);
    expect(second.wakesFired).toBe(0);

    // No new audit rows were written on the second run.
    const auditsAfterSecond = await readAuditEntries();
    expect(auditsAfterSecond).toHaveLength(auditsAfterFirst.length);
  });

  it("scans every company in the instance (no per-company filter)", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const agentA = await seedAgent(companyA);
    const agentB = await seedAgent(companyB);

    const blockerA = await seedIssue({ companyId: companyA, status: "done" });
    const dependentA = await seedIssue({
      companyId: companyA,
      status: "blocked",
      assigneeAgentId: agentA,
    });
    await addBlocker({ companyId: companyA, blockerId: blockerA, dependentId: dependentA });

    const blockerB = await seedIssue({ companyId: companyB, status: "done" });
    const dependentB = await seedIssue({
      companyId: companyB,
      status: "blocked",
      assigneeAgentId: agentB,
    });
    await addBlocker({ companyId: companyB, blockerId: blockerB, dependentId: dependentB });

    await enableFlag();

    const result = await issueReconciliationService(db).reconcileIssueBlockersDaily({
      now: FIXED_NOW,
    });

    expect(result.companiesScanned).toBe(2);
    expect(result.dependentsTouched).toBe(2);
    expect(result.blockersRemoved).toBe(2);

    expect((await readIssue(dependentA))?.status).toBe("todo");
    expect((await readIssue(dependentB))?.status).toBe("todo");

    const audits = await readAuditEntries();
    expect(audits).toHaveLength(2);
  });
});
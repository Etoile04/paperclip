/**
 * ADR-009 §4.3-b (NFM-3585) — Auto-transition blocked → todo|in_progress + Paperclip wake.
 *
 * Sibling B scope:
 *   - When the §4.3-a scan removes a dependent's terminal blockers AND the
 *     dependent has zero remaining blockers (`after == []`) AND the
 *     dependent's status is currently `blocked`, transition the dependent to:
 *       - `in_progress` if it has an active `checkoutRunId` (preserve lease)
 *       - `todo`      otherwise
 *   - Emit a Paperclip heartbeat wake to `dependent.assigneeAgentId` via the
 *     existing `enqueueWakeup` primitive (DI-injected into `recoveryService`).
 *   - Conditional: NO transition and NO wake when `after != []` or
 *     `dependent.status != "blocked"`.
 *
 * The four required branches:
 *   1. `blocked` + no checkoutRunId                  → `todo`,      wake
 *   2. `blocked` + active checkoutRunId              → `in_progress`, wake
 *   3. other live blockers remain (`after != []`)    → no transition, no wake
 *   4. dependent.status != `blocked`                 → no transition, no wake
 *
 * Plus edge cases:
 *   - `blocked` + no assignee                       → transition to todo, no wake
 *   - feature flag OFF                               → no transition, no wake
 *   - re-run idempotence                             → no double-wake
 *
 * Branch 3 lives in `recovery-reconcile-blocked-by-issue-ids.test.ts`
 * (Sibling A's test file) — the existing "removes only the blockers" test
 * there now asserts the §4.3-b no-op behaviour under `after != []`.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { instanceSettingsService } from "../services/instance-settings.ts";
import { recoveryService } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres §4.3-b tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type WakeCall = {
  agentId: string;
  opts: {
    source?: string;
    triggerDetail?: string | null;
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
  };
};

function makeWakeRecorder() {
  const calls: WakeCall[] = [];
  const fn = async (agentId: string, opts: WakeCall["opts"] = {}) => {
    calls.push({ agentId, opts });
  };
  return { fn, calls };
}

describeEmbeddedPostgres("recoveryService.reconcileBlockedByIssueIds (ADR-009 §4.3-b)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reconcile-b-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Reconcile-B Co",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reconcile-B Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: false });
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ---- helpers ---------------------------------------------------------------

  async function seedIssue(opts: {
    id: string;
    title: string;
    status: "todo" | "in_progress" | "blocked" | "in_review" | "backlog" | "done" | "cancelled";
    assigneeAgentId?: string | null;
    checkoutRunId?: string | null;
  }): Promise<void> {
    await db.insert(issues).values({
      id: opts.id,
      companyId,
      title: opts.title,
      status: opts.status,
      priority: "medium",
      assigneeAgentId: opts.assigneeAgentId ?? null,
      checkoutRunId: opts.checkoutRunId ?? null,
    });
  }

  async function seedBlocksRelation(blockerId: string, dependentId: string): Promise<void> {
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      issueId: blockerId,
      relatedIssueId: dependentId,
      kind: "blocks",
      type: "blocks",
      createdAt: new Date(),
    });
  }

  async function setupHeartbeatRun(): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
    });
    return runId;
  }

  async function blockerIdsFor(dependentId: string): Promise<string[]> {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, dependentId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((r) => r.blockerIssueId));
  }

  async function readDependent(dependentId: string) {
    const rows = await db.select().from(issues).where(eq(issues.id, dependentId));
    return rows[0];
  }

  // ---- branch 1: blocked + no checkout → todo + wake -------------------------

  it("branch 1 — blocked dependent with no checkout transitions to todo and fires a wake", async () => {
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await seedIssue({ id: blockerId, title: "Cancelled blocker", status: "cancelled" });
    await seedIssue({
      id: dependentId,
      title: "Dependent",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await seedBlocksRelation(blockerId, dependentId);

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: true });

    const wake = makeWakeRecorder();
    const svc = recoveryService(db, { enqueueWakeup: wake.fn });
    const result = await svc.reconcileBlockedByIssueIds();

    expect(result.skippedFlagOff).toBe(false);
    expect(result.dependentsUpdated).toBe(1);
    expect(result.dependentsTransitioned).toBe(1);
    expect(result.wakesFired).toBe(1);
    expect(result.statusTransitions).toHaveLength(1);
    expect(result.statusTransitions[0]).toMatchObject({
      dependentId,
      closingIssueIds: [blockerId],
      fromStatus: "blocked",
      toStatus: "todo",
      assigneeAgentId: agentId,
    });
    expect(result.statusTransitions[0]?.ts).toBeInstanceOf(Date);

    const dependentAfter = await readDependent(dependentId);
    expect(dependentAfter?.status).toBe("todo");
    expect(dependentAfter?.checkoutRunId).toBeNull();
    expect(await blockerIdsFor(dependentId)).toEqual([]);

    expect(wake.calls).toHaveLength(1);
    expect(wake.calls[0]?.agentId).toBe(agentId);
    expect(wake.calls[0]?.opts.source).toBe("automation");
    expect(wake.calls[0]?.opts.triggerDetail).toBe("system");
    expect(wake.calls[0]?.opts.reason).toBe("adr-009-blocker-cleared-daily-reconcile");
    expect(wake.calls[0]?.opts.requestedByActorType).toBe("system");
    expect(wake.calls[0]?.opts.requestedByActorId).toBe("adr-009-reconciliation");
    expect(wake.calls[0]?.opts.payload).toMatchObject({
      issueId: dependentId,
      trigger: "adr-009-§4.3-b",
      fromStatus: "blocked",
      toStatus: "todo",
      clearedBlockerIssueIds: [blockerId],
    });
    expect(wake.calls[0]?.opts.idempotencyKey).toBe(
      `adr-009:§4.3-b:${dependentId}:${blockerId}`,
    );
  });

  // ---- branch 2: blocked + active checkout → in_progress + wake --------------

  it("branch 2 — blocked dependent with an active checkout transitions to in_progress and fires a wake (preserves checkoutRunId)", async () => {
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    const checkoutRunId = await setupHeartbeatRun();
    await seedIssue({ id: blockerId, title: "Done blocker", status: "done" });
    await seedIssue({
      id: dependentId,
      title: "Dependent",
      status: "blocked",
      assigneeAgentId: agentId,
      checkoutRunId,
    });
    await seedBlocksRelation(blockerId, dependentId);

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: true });

    const wake = makeWakeRecorder();
    const svc = recoveryService(db, { enqueueWakeup: wake.fn });
    const result = await svc.reconcileBlockedByIssueIds();

    expect(result.dependentsTransitioned).toBe(1);
    expect(result.wakesFired).toBe(1);
    expect(result.statusTransitions[0]).toMatchObject({
      dependentId,
      closingIssueIds: [blockerId],
      fromStatus: "blocked",
      toStatus: "in_progress",
      assigneeAgentId: agentId,
    });

    const dependentAfter = await readDependent(dependentId);
    expect(dependentAfter?.status).toBe("in_progress");
    // The active checkoutRunId MUST be preserved across the auto-transition.
    expect(dependentAfter?.checkoutRunId).toBe(checkoutRunId);
    expect(dependentAfter?.startedAt).toBeInstanceOf(Date);

    expect(wake.calls).toHaveLength(1);
    expect(wake.calls[0]?.agentId).toBe(agentId);
    expect(wake.calls[0]?.opts.idempotencyKey).toBe(
      `adr-009:§4.3-b:${dependentId}:${blockerId}`,
    );
  });

  // ---- branch 3: other live blockers remain → no transition, no wake ---------

  it("branch 3 — does NOT transition or wake when other live blockers remain after the sweep", async () => {
    const doneBlocker = randomUUID();
    const liveBlocker = randomUUID();
    const dependentId = randomUUID();
    await seedIssue({ id: doneBlocker, title: "Done blocker", status: "done" });
    await seedIssue({ id: liveBlocker, title: "Live blocker", status: "todo" });
    await seedIssue({
      id: dependentId,
      title: "Dependent",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await seedBlocksRelation(doneBlocker, dependentId);
    await seedBlocksRelation(liveBlocker, dependentId);

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: true });

    const wake = makeWakeRecorder();
    const svc = recoveryService(db, { enqueueWakeup: wake.fn });
    const result = await svc.reconcileBlockedByIssueIds();

    expect(result.dependentsUpdated).toBe(1);
    expect(result.blockerRelationsRemoved).toBe(1);
    expect(result.dependentsTransitioned).toBe(0);
    expect(result.statusTransitions).toEqual([]);
    expect(result.wakesFired).toBe(0);

    const dependentAfter = await readDependent(dependentId);
    expect(dependentAfter?.status).toBe("blocked");
    expect(wake.calls).toEqual([]);
    expect((await blockerIdsFor(dependentId)).sort()).toEqual([liveBlocker].sort());
  });

  // ---- branch 4: dependent.status != blocked → no transition, no wake --------

  it("branch 4 — does NOT transition or wake when the dependent is not in blocked status", async () => {
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await seedIssue({ id: blockerId, title: "Done blocker", status: "done" });
    await seedIssue({
      id: dependentId,
      title: "Dependent already in todo",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await seedBlocksRelation(blockerId, dependentId);

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: true });

    const wake = makeWakeRecorder();
    const svc = recoveryService(db, { enqueueWakeup: wake.fn });
    const result = await svc.reconcileBlockedByIssueIds();

    expect(result.dependentsUpdated).toBe(1);
    expect(result.blockerRelationsRemoved).toBe(1);
    expect(result.dependentsTransitioned).toBe(0);
    expect(result.statusTransitions).toEqual([]);
    expect(result.wakesFired).toBe(0);

    const dependentAfter = await readDependent(dependentId);
    expect(dependentAfter?.status).toBe("todo");
    expect(wake.calls).toEqual([]);
    expect(await blockerIdsFor(dependentId)).toEqual([]);
  });

  // ---- edge: blocked + no assignee → transition but no wake ------------------

  it("edge — blocked dependent with no assignee transitions to todo but does NOT fire a wake", async () => {
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await seedIssue({ id: blockerId, title: "Done blocker", status: "done" });
    await seedIssue({
      id: dependentId,
      title: "Unassigned dependent",
      status: "blocked",
      assigneeAgentId: null,
    });
    await seedBlocksRelation(blockerId, dependentId);

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: true });

    const wake = makeWakeRecorder();
    const svc = recoveryService(db, { enqueueWakeup: wake.fn });
    const result = await svc.reconcileBlockedByIssueIds();

    // The transition MUST still fire (so the work can be picked up later),
    // but there is no agent to wake.
    expect(result.dependentsTransitioned).toBe(1);
    expect(result.statusTransitions).toHaveLength(1);
    expect(result.statusTransitions[0]).toMatchObject({
      dependentId,
      toStatus: "todo",
      assigneeAgentId: null,
    });
    expect(result.wakesFired).toBe(0);

    const dependentAfter = await readDependent(dependentId);
    expect(dependentAfter?.status).toBe("todo");
    expect(wake.calls).toEqual([]);
  });

  // ---- edge: feature flag OFF → no transition, no wake -----------------------

  it("edge — does NOT transition or wake when the feature flag is disabled", async () => {
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await seedIssue({ id: blockerId, title: "Done blocker", status: "done" });
    await seedIssue({
      id: dependentId,
      title: "Dependent",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await seedBlocksRelation(blockerId, dependentId);

    // Flag stays at the default false (set in beforeEach).
    const wake = makeWakeRecorder();
    const svc = recoveryService(db, { enqueueWakeup: wake.fn });
    const result = await svc.reconcileBlockedByIssueIds();

    expect(result.skippedFlagOff).toBe(true);
    expect(result.dependentsUpdated).toBe(0);
    expect(result.dependentsTransitioned).toBe(0);
    expect(result.statusTransitions).toEqual([]);
    expect(result.wakesFired).toBe(0);

    const dependentAfter = await readDependent(dependentId);
    expect(dependentAfter?.status).toBe("blocked");
    expect(wake.calls).toEqual([]);
    expect(await blockerIdsFor(dependentId)).toEqual([blockerId]);
  });

  // ---- idempotence: re-run does NOT double-transition or double-wake --------

  it("idempotence — re-running reconcile in the same window does NOT double-wake the same assignee", async () => {
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await seedIssue({ id: blockerId, title: "Cancelled blocker", status: "cancelled" });
    await seedIssue({
      id: dependentId,
      title: "Dependent",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await seedBlocksRelation(blockerId, dependentId);

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: true });

    const wake = makeWakeRecorder();
    const svc = recoveryService(db, { enqueueWakeup: wake.fn });

    // First run: transition + wake fires once.
    const first = await svc.reconcileBlockedByIssueIds();
    expect(first.dependentsUpdated).toBe(1);
    expect(first.dependentsTransitioned).toBe(1);
    expect(first.wakesFired).toBe(1);
    expect(wake.calls).toHaveLength(1);

    // Second run: bucket is empty (terminal relation already deleted),
    // so nothing to do — and crucially NO second wake.
    const second = await svc.reconcileBlockedByIssueIds();
    expect(second.dependentsUpdated).toBe(0);
    expect(second.dependentsTransitioned).toBe(0);
    expect(second.wakesFired).toBe(0);
    expect(second.statusTransitions).toEqual([]);
    expect(wake.calls).toHaveLength(1);

    const dependentAfter = await readDependent(dependentId);
    expect(dependentAfter?.status).toBe("todo");
  });

  // ---- multi-company: each company's dependents transition independently -----

  it("multi-company — every company contributes its own dependents and wakes", async () => {
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Reconcile-B Co",
      issuePrefix: `X${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "Other Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const cancelledA = randomUUID();
    const dependentA = randomUUID();
    const cancelledB = randomUUID();
    const dependentB = randomUUID();

    await db.insert(issues).values([
      { id: cancelledA, companyId, title: "CoA cancelled", status: "cancelled", priority: "medium", assigneeAgentId: agentId },
      { id: dependentA, companyId, title: "CoA dependent", status: "blocked", priority: "medium", assigneeAgentId: agentId },
      { id: cancelledB, companyId: otherCompanyId, title: "CoB cancelled", status: "cancelled", priority: "medium", assigneeAgentId: otherAgentId },
      { id: dependentB, companyId: otherCompanyId, title: "CoB dependent", status: "blocked", priority: "medium", assigneeAgentId: otherAgentId },
    ]);
    await db.insert(issueRelations).values([
      { id: randomUUID(), companyId, issueId: cancelledA, relatedIssueId: dependentA, kind: "blocks", type: "blocks", createdAt: new Date() },
      { id: randomUUID(), companyId: otherCompanyId, issueId: cancelledB, relatedIssueId: dependentB, kind: "blocks", type: "blocks", createdAt: new Date() },
    ]);

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: true });

    const wake = makeWakeRecorder();
    const svc = recoveryService(db, { enqueueWakeup: wake.fn });
    const result = await svc.reconcileBlockedByIssueIds();

    expect(result.dependentsUpdated).toBe(2);
    expect(result.dependentsTransitioned).toBe(2);
    expect(result.wakesFired).toBe(2);
    expect(result.statusTransitions).toHaveLength(2);
    expect(wake.calls).toHaveLength(2);

    const aWake = wake.calls.find((c) => c.agentId === agentId);
    const bWake = wake.calls.find((c) => c.agentId === otherAgentId);
    expect(aWake?.agentId).toBe(agentId);
    expect(bWake?.agentId).toBe(otherAgentId);

    const [depAAfter] = await db.select().from(issues).where(eq(issues.id, dependentA));
    const [depBAfter] = await db.select().from(issues).where(eq(issues.id, dependentB));
    expect(depAAfter?.status).toBe("todo");
    expect(depBAfter?.status).toBe("todo");
  });
});
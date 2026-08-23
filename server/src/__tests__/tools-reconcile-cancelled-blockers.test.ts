/**
 * ADR-009 §4.3-b (NFM-3600) — Dry-run script + 5-wedge fixture.
 *
 * Verifies `recoveryService.reconcileBlockedByIssueIds` against the §4.3-b
 * acceptance criteria from NFM-3600:
 *   - seed 5 fake cancelled-blocker wedges
 *   - invoke the reconcile routine
 *   - assert all 5 dependents have `blockedByIssueIds == []`
 *   - assert 5 audit log entries written with the correct closing-issue UUID
 *   - assert idempotence (second run = zero changes)
 *
 * Also exercises the dry-run path (NFM-3600 §4.3-b dry-run script contract):
 *   - `dryRun: true` does NOT delete `issueRelations` rows
 *   - `dryRun: true` does NOT write `issue.cancelled_blocker_reconciled` audit rows
 *   - `dryRun: true` still returns the first 10 cleared dependencies with
 *     before/after `blockedByIssueIds` so the CLI can print them.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
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
    `Skipping embedded Postgres reconcile-cancelled-blockers tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type IssueSeed = {
  id: string;
  title: string;
  status: "todo" | "in_progress" | "blocked" | "in_review" | "backlog" | "done" | "cancelled";
};

describeEmbeddedPostgres("recoveryService.reconcileBlockedByIssueIds — §4.3-b 5-wedge fixture (NFM-3600)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  const enqueueWakeup = vi.fn();
  const recovery = enqueueWakeup as unknown as Parameters<typeof recoveryService>[1]["enqueueWakeup"];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reconcile-cancelled-blockers-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Reconcile Cancelled Blockers Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cancelled Blocker Reconcile Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: true });
    enqueueWakeup.mockReset();
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

  async function seedIssue(seed: IssueSeed): Promise<void> {
    await db.insert(issues).values({
      id: seed.id,
      companyId,
      title: seed.title,
      status: seed.status,
      priority: "medium",
      assigneeAgentId: agentId,
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

  /** Seed N fake cancelled-blocker wedges. Returns (cancelledIds, dependentIds). */
  async function seedFiveWedges(): Promise<{
    cancelledBlockerIds: string[];
    dependentIds: string[];
  }> {
    const cancelledBlockerIds: string[] = [];
    const dependentIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const blockerId = randomUUID();
      const dependentId = randomUUID();
      cancelledBlockerIds.push(blockerId);
      dependentIds.push(dependentId);
      await seedIssue({ id: blockerId, title: `Cancelled ${i}`, status: "cancelled" });
      await seedIssue({ id: dependentId, title: `Dependent ${i}`, status: "blocked" });
      await seedBlocksRelation(blockerId, dependentId);
    }
    return { cancelledBlockerIds, dependentIds };
  }

  it("clears all 5 dependents and writes one audit entry per cleared wedge (auditLog=true)", async () => {
    const { cancelledBlockerIds, dependentIds } = await seedFiveWedges();

    const svc = recoveryService(db, { enqueueWakeup: recovery });
    const result = await svc.reconcileBlockedByIssueIds({ auditLog: true });

    expect(result.skippedFlagOff).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.auditLog).toBe(true);
    expect(result.dependentsUpdated).toBe(5);
    expect(result.blockerRelationsRemoved).toBe(5);
    expect(result.removedByStatus).toEqual({ done: 0, cancelled: 5 });

    for (const dependentId of dependentIds) {
      expect(await blockerIdsFor(dependentId)).toEqual([]);
    }

    const auditRows = await db
      .select({
        action: activityLog.action,
        entityId: activityLog.entityId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.cancelled_blocker_reconciled"));

    expect(auditRows).toHaveLength(5);
    const auditEntityIds = auditRows.map((row) => row.entityId).sort();
    expect(auditEntityIds).toEqual([...dependentIds].sort());

    const removedBlockerByDependent = new Map<string, string[]>();
    for (const row of auditRows) {
      const details = (row.details ?? {}) as {
        removedBlockerIds?: string[];
        removedByStatus?: { done: number; cancelled: number };
      };
      expect(details.removedByStatus).toEqual({ done: 0, cancelled: 1 });
      removedBlockerByDependent.set(row.entityId, details.removedBlockerIds ?? []);
    }
    for (let i = 0; i < dependentIds.length; i += 1) {
      const dependentId = dependentIds[i];
      const expectedBlockerId = cancelledBlockerIds[i];
      expect(removedBlockerByDependent.get(dependentId)).toEqual([expectedBlockerId]);
    }
  });

  it("is idempotent — second run after the 5-wedge sweep produces zero changes", async () => {
    await seedFiveWedges();

    const svc = recoveryService(db, { enqueueWakeup: recovery });
    const first = await svc.reconcileBlockedByIssueIds({ auditLog: true });
    const second = await svc.reconcileBlockedByIssueIds({ auditLog: true });

    expect(first.dependentsUpdated).toBe(5);
    expect(first.blockerRelationsRemoved).toBe(5);

    expect(second.dependentsUpdated).toBe(0);
    expect(second.blockerRelationsRemoved).toBe(0);
    expect(second.dependentsScanned).toBe(0);
    expect(second.skippedFlagOff).toBe(false);

    const auditCount = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.cancelled_blocker_reconciled"))
      .then((rows) => rows.length);
    expect(auditCount).toBe(5);
  });

  it("dry-run does not mutate issueRelations or write audit rows, but returns a clearedDependencies sample", async () => {
    const { cancelledBlockerIds, dependentIds } = await seedFiveWedges();

    const svc = recoveryService(db, { enqueueWakeup: recovery });
    const result = await svc.reconcileBlockedByIssueIds({ dryRun: true });

    expect(result.skippedFlagOff).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.auditLog).toBe(false);
    expect(result.dependentsUpdated).toBe(5);
    expect(result.blockerRelationsRemoved).toBe(5);

    for (let i = 0; i < dependentIds.length; i += 1) {
      const remaining = await blockerIdsFor(dependentIds[i]);
      expect(remaining).toEqual([cancelledBlockerIds[i]]);
    }

    const auditRows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(inArray(activityLog.action, ["issue.cancelled_blocker_reconciled", "issue.blocker_reconcile_removed"]))
      .then((rows) => rows);
    expect(auditRows).toEqual([]);

    expect(result.clearedDependencies).toHaveLength(5);
    for (let i = 0; i < result.clearedDependencies.length; i += 1) {
      const cleared = result.clearedDependencies[i];
      const expectedBlockerId = cancelledBlockerIds[i];
      expect(cleared.beforeBlockerIssueIds).toEqual([expectedBlockerId]);
      expect(cleared.afterBlockerIssueIds).toEqual([]);
      expect(cleared.removedBlockerIssueIds).toEqual([expectedBlockerId]);
      expect(cleared.removedByStatus).toEqual({ done: 0, cancelled: 1 });
    }
  });

  it("dry-run followed by real reconcile produces the same final state, but only the real run writes audit rows", async () => {
    await seedFiveWedges();

    const svc = recoveryService(db, { enqueueWakeup: recovery });

    const dry = await svc.reconcileBlockedByIssueIds({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.dependentsUpdated).toBe(5);

    const real = await svc.reconcileBlockedByIssueIds({ auditLog: true });
    expect(real.dryRun).toBe(false);
    expect(real.auditLog).toBe(true);
    expect(real.dependentsUpdated).toBe(5);

    const auditCount = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.cancelled_blocker_reconciled"))
      .then((rows) => rows.length);
    expect(auditCount).toBe(5);

    const after = await svc.reconcileBlockedByIssueIds({ auditLog: true });
    expect(after.dependentsUpdated).toBe(0);
    expect(after.blockerRelationsRemoved).toBe(0);

    const auditCountAfter = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.cancelled_blocker_reconciled"))
      .then((rows) => rows.length);
    expect(auditCountAfter).toBe(5);
  });

  it("default invocation (no options) preserves Sibling A's audit-free contract", async () => {
    await seedFiveWedges();

    const svc = recoveryService(db, { enqueueWakeup: recovery });
    const result = await svc.reconcileBlockedByIssueIds();

    expect(result.dryRun).toBe(false);
    expect(result.auditLog).toBe(false);
    expect(result.dependentsUpdated).toBe(5);

    const auditRows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.cancelled_blocker_reconciled"))
      .then((rows) => rows);
    expect(auditRows).toEqual([]);
  });
});

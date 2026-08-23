/**
 * ADR-009 §4.3 (NFM-3584 + NFM-3585): Daily 06:00 UTC reconciliation routine.
 *
 * Sibling A (NFM-3584) — Cron entry + scan loop + idempotence guard:
 *   - returns early when `adr009ReconciliationHookEnabled` is false
 *   - scans every issue's blocker relations and removes UUIDs whose
 *     referenced issue is `done` or `cancelled`
 *   - leaves non-terminal blockers untouched
 *   - is idempotent (running twice yields zero second-pass changes)
 *
 * Sibling B (NFM-3585) is exercised in this file only via the Branch 3
 * (`after != []` — other live blockers remain) path: when a dependent has
 * non-terminal blockers alongside the cleared ones, §4.3-b MUST NOT
 * transition or wake. The remaining branches (1, 2, 4 + idempotence) are
 * covered exhaustively in `recovery-reconcile-blocked-by-issue-ids-b.test.ts`.
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
    `Skipping embedded Postgres reconcile-blocked-by-issue-ids tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type IssueSeed = {
  id: string;
  title: string;
  status: "todo" | "in_progress" | "blocked" | "in_review" | "backlog" | "done" | "cancelled";
};

describeEmbeddedPostgres("recoveryService.reconcileBlockedByIssueIds (ADR-009 §4.3-a)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  const enqueueWakeup = vi.fn();
  const recovery = enqueueWakeup as unknown as Parameters<typeof recoveryService>[1]["enqueueWakeup"];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reconcile-blocked-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Reconcile Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reconcile Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Make sure the flag is OFF before each test, then opt-in per test.
    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: false });
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

  it("returns early without touching DB when the flag is OFF", async () => {
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await seedIssue({ id: blockerId, title: "Cancelled blocker", status: "cancelled" });
    await seedIssue({ id: dependentId, title: "Dependent", status: "blocked" });
    await seedBlocksRelation(blockerId, dependentId);

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: false });
    const svc = recoveryService(db, { enqueueWakeup: recovery });
    const result = await svc.reconcileBlockedByIssueIds();

    expect(result.skippedFlagOff).toBe(true);
    expect(result.dependentsScanned).toBe(0);
    expect(await blockerIdsFor(dependentId)).toEqual([blockerId]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("removes only the blockers whose referenced issue is done or cancelled", async () => {
    const doneBlocker = randomUUID();
    const cancelledBlocker = randomUUID();
    const todoBlocker = randomUUID();
    const inProgressBlocker = randomUUID();
    const dependentId = randomUUID();

    await seedIssue({ id: doneBlocker, title: "Done", status: "done" });
    await seedIssue({ id: cancelledBlocker, title: "Cancelled", status: "cancelled" });
    await seedIssue({ id: todoBlocker, title: "Todo", status: "todo" });
    await seedIssue({ id: inProgressBlocker, title: "In progress", status: "in_progress" });
    await seedIssue({ id: dependentId, title: "Dependent", status: "blocked" });

    await seedBlocksRelation(doneBlocker, dependentId);
    await seedBlocksRelation(cancelledBlocker, dependentId);
    await seedBlocksRelation(todoBlocker, dependentId);
    await seedBlocksRelation(inProgressBlocker, dependentId);

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: true });
    const svc = recoveryService(db, { enqueueWakeup: recovery });
    const result = await svc.reconcileBlockedByIssueIds();

    expect(result.skippedFlagOff).toBe(false);
    expect(result.dependentsScanned).toBeGreaterThanOrEqual(1);
    expect(result.dependentsUpdated).toBe(1);
    expect(result.blockerRelationsRemoved).toBe(2);

    const remaining = (await blockerIdsFor(dependentId)).sort();
    expect(remaining).toEqual([inProgressBlocker, todoBlocker].sort());
    // §4.3-b Branch 3 (`after != []`): two live blockers remain after the
    // terminal-blocker sweep, so the dependent must NOT be transitioned and
    // NO wake may fire. Sibling B's other branches live in the sibling-B
    // test file.
    expect(result.statusTransitions).toEqual([]);
    expect(result.dependentsTransitioned).toBe(0);
    expect(result.wakesFired).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("is idempotent — running twice yields zero second-pass changes", async () => {
    const doneBlocker = randomUUID();
    const dependentId = randomUUID();
    await seedIssue({ id: doneBlocker, title: "Done", status: "done" });
    await seedIssue({ id: dependentId, title: "Dependent", status: "blocked" });
    await seedBlocksRelation(doneBlocker, dependentId);

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: true });
    const svc = recoveryService(db, { enqueueWakeup: recovery });

    const first = await svc.reconcileBlockedByIssueIds();
    const second = await svc.reconcileBlockedByIssueIds();

    expect(first.dependentsUpdated).toBe(1);
    expect(first.blockerRelationsRemoved).toBe(1);

    expect(second.dependentsUpdated).toBe(0);
    expect(second.blockerRelationsRemoved).toBe(0);
    // Second pass scans the now-empty relation set, so scanned=0 is the
    // correct idempotence invariant — what matters is zero mutations.
    expect(second.dependentsScanned).toBe(0);
    expect(second.skippedFlagOff).toBe(false);

    expect(await blockerIdsFor(dependentId)).toEqual([]);
  });

  it("scans multiple companies — every company contributes its own dependents", async () => {
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const otherAgentId = randomUUID();
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
      { id: cancelledA, companyId, title: "Co1 cancelled", status: "cancelled", priority: "medium", assigneeAgentId: agentId },
      { id: dependentA, companyId, title: "Co1 dependent", status: "blocked", priority: "medium", assigneeAgentId: agentId },
      { id: cancelledB, companyId: otherCompanyId, title: "Co2 cancelled", status: "cancelled", priority: "medium", assigneeAgentId: otherAgentId },
      { id: dependentB, companyId: otherCompanyId, title: "Co2 dependent", status: "blocked", priority: "medium", assigneeAgentId: otherAgentId },
    ]);
    await seedBlocksRelation(cancelledA, dependentA);
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId: otherCompanyId,
      issueId: cancelledB,
      relatedIssueId: dependentB,
      kind: "blocks",
      type: "blocks",
      createdAt: new Date(),
    });

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: true });
    const svc = recoveryService(db, { enqueueWakeup: recovery });
    const result = await svc.reconcileBlockedByIssueIds();

    expect(result.dependentsUpdated).toBe(2);
    expect(result.blockerRelationsRemoved).toBe(2);
    expect(await blockerIdsFor(dependentA)).toEqual([]);
    expect(await blockerIdsFor(dependentB)).toEqual([]);
  });

  it("does not write an `activityLog` audit row — Sibling C scope (NFM-3586)", async () => {
    // This test was originally written as a combined Sibling B/C scope guard
    // ("no wake, no audit"). After Sibling B shipped (NFM-3585), the
    // auto-transition + wake ARE expected for the single-blocker blocked
    // dependent case below — but the `activityLog` audit emission remains
    // Sibling C's responsibility (NFM-3586). The wake-side coverage for this
    // exact scenario lives in `recovery-reconcile-blocked-by-issue-ids-b.test.ts`.
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await seedIssue({ id: blockerId, title: "Done", status: "done" });
    await seedIssue({ id: dependentId, title: "Dependent", status: "blocked" });
    await seedBlocksRelation(blockerId, dependentId);

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: true });
    const svc = recoveryService(db, { enqueueWakeup: recovery });
    await svc.reconcileBlockedByIssueIds();

    const audit = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(inArray(activityLog.action, ["issue.blocker_reconcile_removed", "issue.blocker_reconcile_run"]))
      .then((rows) => rows);
    expect(audit).toEqual([]);
  });
});
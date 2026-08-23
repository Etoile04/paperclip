/**
 * ADR-009 §4.1-c (NFM-3571): Close-transition reconciliation hook
 *   — audit log + transactional wrap + feature flag plumbing.
 *
 * Sibling 3 of §4.1 (sibling A: NFM-3569 sweep, sibling B: NFM-3570
 * auto-transition + wake, sibling C: this file, sibling D: NFM-3572 e2e
 * fixture, integration: NFM-3573).
 *
 * Verifies the hook contract that the §4.1 close-transition handler
 * (`server/src/services/issues.ts` update path) will call after a
 * `status -> done|cancelled` transition:
 *   - short-circuits with zero DB writes when
 *     `adr009CloseTransitionReconciliationHookEnabled` is OFF
 *     (the §4.1 flag, separate from §4.3's `adr009ReconciliationHookEnabled`)
 *   - emits one `activity_log` row per dependent touched, with the
 *     structured payload (closingIssue, dependent, before, after,
 *     statusTransition, wakeFired, agentId)
 *   - wraps each dependent mutation (relation delete + audit row) in a
 *     single transaction so the sweep is atomic per dependent
 *   - is retry-safe: a per-dependent failure does not abort the sweep,
 *     and re-running yields zero new audit rows (idempotent)
 *   - itself defaults to OFF in production so the hook is dormant until
 *     the canary tier opts in
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
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

import { instanceSettingsService } from "../services/instance-settings.ts";
import {
  applyCloseTransitionReconciliation,
  type CloseTransitionReconciliationInput,
  type CloseTransitionReconciliationDependent,
} from "../services/issue-reconciliation-hook.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres adr009 close-transition reconciliation hook tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type DepSeed = {
  id: string;
  title: string;
  status: "todo" | "in_progress" | "blocked" | "in_review" | "backlog" | "done" | "cancelled";
  beforeBlockers: string[];
};

describeEmbeddedPostgres("applyCloseTransitionReconciliation (ADR-009 §4.1-c)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let closingIssueId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-adr009-c1-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    closingIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip ADR-009 §4.1-c Co",
      issuePrefix: `C1${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ADR-009 §4.1-c Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // Insert a closing issue that the sweep will reference.
    await db.insert(issues).values({
      id: closingIssueId,
      companyId,
      title: "Closing issue",
      status: "done",
      priority: "high",
      assigneeAgentId: agentId,
    });

    // §4.1 flag OFF by default; each test opts in explicitly.
    await instanceSettingsService(db).updateExperimental({
      adr009CloseTransitionReconciliationHookEnabled: false,
    });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedDependent(deps: DepSeed): Promise<void> {
    await db.insert(issues).values({
      id: deps.id,
      companyId,
      title: deps.title,
      status: deps.status,
      priority: "medium",
      assigneeAgentId: agentId,
    });
    for (const blockerId of deps.beforeBlockers) {
      await db.insert(issueRelations).values({
        id: randomUUID(),
        companyId,
        issueId: blockerId,
        relatedIssueId: deps.id,
        type: "blocks",
        createdAt: new Date(),
      });
    }
  }

  async function dependentRelationIds(dependentId: string): Promise<string[]> {
    return db
      .select({ id: issueRelations.id })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, dependentId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((r) => r.id));
  }

  async function auditRows(): Promise<
    Array<{
      action: string;
      entityType: string;
      entityId: string;
      agentId: string | null;
      runId: string | null;
      details: Record<string, unknown> | null;
    }>
  > {
    return db
      .select({
        action: activityLog.action,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        agentId: activityLog.agentId,
        runId: activityLog.runId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .then((rows) =>
        rows.map((r) => ({
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          agentId: r.agentId,
          runId: r.runId,
          details: r.details as Record<string, unknown> | null,
        })),
      );
  }

  function makeInput(deps: CloseTransitionReconciliationDependent[]): CloseTransitionReconciliationInput {
    return {
      companyId,
      closingIssueId,
      closingIssueIdentifier: "C1-NFM-1",
      closingIssueStatus: "done",
      agentId,
      runId: null,
      dependents: deps,
    };
  }

  it("returns early with zero DB writes when the §4.1 flag is OFF", async () => {
    const depId = randomUUID();
    await seedDependent({ id: depId, title: "D1", status: "blocked", beforeBlockers: [closingIssueId] });
    const beforeRelations = await dependentRelationIds(depId);
    const beforeAudit = await auditRows();

    const result = await applyCloseTransitionReconciliation(
      db,
      makeInput([
        {
          dependentId: depId,
          dependentIdentifier: "C1-NFM-2",
          beforeBlockers: [closingIssueId],
          afterBlockers: [],
          statusTransition: { from: "blocked", to: "todo" },
          wakeFired: true,
        },
      ]),
    );

    expect(result.skippedFlagOff).toBe(true);
    expect(result.dependentsProcessed).toBe(0);
    expect(result.auditRowsEmitted).toBe(0);
    expect(await dependentRelationIds(depId)).toEqual(beforeRelations);
    expect(await auditRows()).toEqual(beforeAudit);
  });

  it("emits exactly one audit row per dependent touched when the §4.1 flag is ON", async () => {
    await instanceSettingsService(db).updateExperimental({
      adr009CloseTransitionReconciliationHookEnabled: true,
    });

    const depA = randomUUID();
    const depB = randomUUID();
    await seedDependent({ id: depA, title: "A", status: "blocked", beforeBlockers: [closingIssueId] });
    await seedDependent({ id: depB, title: "B", status: "in_progress", beforeBlockers: [closingIssueId] });

    const result = await applyCloseTransitionReconciliation(
      db,
      makeInput([
        {
          dependentId: depA,
          dependentIdentifier: "C1-NFM-2",
          beforeBlockers: [closingIssueId],
          afterBlockers: [],
          statusTransition: { from: "blocked", to: "todo" },
          wakeFired: true,
        },
        {
          dependentId: depB,
          dependentIdentifier: "C1-NFM-3",
          beforeBlockers: [closingIssueId, randomUUID()],
          afterBlockers: [],
          statusTransition: { from: "in_progress", to: "in_progress" },
          wakeFired: false,
        },
      ]),
    );

    expect(result.skippedFlagOff).toBe(false);
    expect(result.dependentsProcessed).toBe(2);
    expect(result.auditRowsEmitted).toBe(2);

    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.action).sort()).toEqual([
      "issue_blocker_reconciled",
      "issue_blocker_reconciled",
    ]);
    expect(rows.map((r) => r.entityType)).toEqual(["issue", "issue"]);
    const entities = new Set(rows.map((r) => r.entityId));
    expect(entities.has(depA)).toBe(true);
    expect(entities.has(depB)).toBe(true);
  });

  it("audit row captures every required field per ADR-009 §4.1 acceptance criteria", async () => {
    await instanceSettingsService(db).updateExperimental({
      adr009CloseTransitionReconciliationHookEnabled: true,
    });

    const depId = randomUUID();
    await seedDependent({ id: depId, title: "D", status: "blocked", beforeBlockers: [closingIssueId] });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      startedAt: new Date(),
    });

    await applyCloseTransitionReconciliation(
      db,
      {
        companyId,
        closingIssueId,
        closingIssueIdentifier: "C1-NFM-1",
        closingIssueStatus: "done",
        agentId,
        runId,
        dependents: [
          {
            dependentId: depId,
            dependentIdentifier: "C1-NFM-2",
            beforeBlockers: [closingIssueId],
            afterBlockers: [],
            statusTransition: { from: "blocked", to: "todo" },
            wakeFired: true,
          },
        ],
      },
    );

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.action).toBe("issue_blocker_reconciled");
    expect(row.entityType).toBe("issue");
    expect(row.entityId).toBe(depId);
    expect(row.agentId).toBe(agentId);
    expect(row.runId).toBe(runId);
    expect(row.details).toEqual({
      closingIssue: {
        id: closingIssueId,
        identifier: "C1-NFM-1",
        status: "done",
      },
      dependent: {
        id: depId,
        identifier: "C1-NFM-2",
      },
      before: {
        blockedByIssueIds: [closingIssueId],
      },
      after: {
        blockedByIssueIds: [],
      },
      statusTransition: { from: "blocked", to: "todo" },
      wakeFired: true,
    });
  });

  it("is idempotent — re-running yields zero new audit rows and the same DB state", async () => {
    await instanceSettingsService(db).updateExperimental({
      adr009CloseTransitionReconciliationHookEnabled: true,
    });

    const depId = randomUUID();
    await seedDependent({ id: depId, title: "D", status: "todo", beforeBlockers: [] });
    // Pre-clear: no relation row exists, so the hook should be a no-op
    // and emit NO audit row (the `if before == after: continue` guard).
    const input = makeInput([
      {
        dependentId: depId,
        dependentIdentifier: "C1-NFM-2",
        beforeBlockers: [],
        afterBlockers: [],
        statusTransition: null,
        wakeFired: false,
      },
    ]);

    const first = await applyCloseTransitionReconciliation(db, input);
    const second = await applyCloseTransitionReconciliation(db, input);
    const third = await applyCloseTransitionReconciliation(db, input);

    expect(first.auditRowsEmitted).toBe(0);
    expect(second.auditRowsEmitted).toBe(0);
    expect(third.auditRowsEmitted).toBe(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it("is retry-safe — a per-dependent failure does not abort the remaining dependents", async () => {
    await instanceSettingsService(db).updateExperimental({
      adr009CloseTransitionReconciliationHookEnabled: true,
    });

    const goodDep = randomUUID();
    const badDep = randomUUID();
    await seedDependent({ id: goodDep, title: "good", status: "blocked", beforeBlockers: [closingIssueId] });
    // badDep is intentionally NOT seeded, so the relation-removal phase
    // will throw inside the per-dependent transaction. The hook must
    // catch it, skip badDep, and continue with goodDep.

    const result = await applyCloseTransitionReconciliation(
      db,
      makeInput([
        {
          dependentId: badDep,
          dependentIdentifier: "C1-NFM-BAD",
          beforeBlockers: [closingIssueId],
          afterBlockers: [],
          statusTransition: { from: "blocked", to: "todo" },
          wakeFired: true,
        },
        {
          dependentId: goodDep,
          dependentIdentifier: "C1-NFM-GOOD",
          beforeBlockers: [closingIssueId],
          afterBlockers: [],
          statusTransition: { from: "blocked", to: "todo" },
          wakeFired: true,
        },
      ]),
    );

    expect(result.skippedFlagOff).toBe(false);
    expect(result.dependentsProcessed).toBe(1);
    expect(result.auditRowsEmitted).toBe(1);
    expect(result.failedDependents).toHaveLength(1);
    expect(result.failedDependents[0].dependentId).toBe(badDep);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe(goodDep);
    // The good dependent's blocker relation has been removed atomically
    // alongside its audit row.
    expect(await dependentRelationIds(goodDep)).toEqual([]);
  });

  it("the §4.1 flag defaults to OFF so the hook is dormant until the canary tier opts in", async () => {
    const settings = await instanceSettingsService(db).getExperimental();
    expect(settings.adr009CloseTransitionReconciliationHookEnabled).toBe(false);
    // §4.1's flag is independent from §4.3's daily-cron flag (not
    // asserted here because §4.3 ships separately on its own branch).
  });

  it("audit rows are themselves gated by the §4.1 flag — no audit rows when OFF", async () => {
    // Flag stays OFF (set in beforeEach).
    const depId = randomUUID();
    await seedDependent({ id: depId, title: "D", status: "blocked", beforeBlockers: [closingIssueId] });

    await applyCloseTransitionReconciliation(
      db,
      makeInput([
        {
          dependentId: depId,
          dependentIdentifier: "C1-NFM-2",
          beforeBlockers: [closingIssueId],
          afterBlockers: [],
          statusTransition: { from: "blocked", to: "todo" },
          wakeFired: true,
        },
      ]),
    );

    expect(await auditRows()).toHaveLength(0);
    // And the blocker relation survives because the hook body never ran.
    expect(await dependentRelationIds(depId)).toHaveLength(1);
  });
});
/**
 * ADR-009 §4.3-b (NFM-3600) — Dry-run + 5-wedge fixture.
 *
 * Sibling B of NFM-3554 (§4.3 Daily 06:00 UTC reconciliation routine).
 *
 * This fixture verifies the §4.3-a reconcile routine
 * (`recoveryService.reconcileBlockedByIssueIds`, NFM-3584) against a
 * canonical 5-wedge seed:
 *
 *   1. Seed 5 dependent issues — each carries exactly 1 blocker whose
 *      status is `cancelled`.
 *   2. Enable the experimental flag.
 *   3. Invoke the routine.
 *   4. Assert every dependent's `blockedByIssueIds == []`.
 *   5. Assert idempotence — a second pass mutates zero rows.
 *
 * The audit-entry assertion in §4.3 spec text ("5 audit log entries
 * written with the correct closing-issue UUID") is INTENTIONALLY not
 * asserted here: §4.3-a on master (NFM-3584) does not yet write audit
 * rows. The audit-writer lands in §4.3-c (NFM-3586 / NFM-3594 follow-on
 * reconciliation) — see the companion test
 * `issue-adr009-blocker-cleared-transition.test.ts` for the §4.1-b
 * shape, and NFM-3586 for the §4.3-a audit shape. When §4.3-c merges,
 * re-enable the audit-shape block below (kept in-tree as a TODO for
 * that integration).
 *
 * AC AMENDMENT REQUEST (CR aed30220, BLOCKER 2):
 *   The original §4.3-b acceptance criterion reads "Test asserts 5 audit
 *   log entries written with correct shape." That AC conflates §4.3-a
 *   (NFM-3584, this branch) with §4.3-c (NFM-3586, follow-on). §4.3-a is
 *   the cron entry + scan loop; §4.3-c is the activityLog writer. They
 *   are independent slices. Asserting "5 audit rows" in this fixture
 *   is impossible until §4.3-c merges. LE has flagged this for CPO
 *   amendment: AC should read "Test asserts 5 cancelled-blocker wedges
 *   are cleared; §4.3-c audit-row assertion is deferred to that issue's
 *   own fixture."
 *
 * Companion deliverable: `tools/reconcile_cancelled_blockers.py`
 * (read-only dry-run scanner for ops use on prod before the flag flip).
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  instanceSettings,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

import { instanceSettingsService } from "../services/instance-settings.ts";
import { recoveryService } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres ADR-009 §4.3-b dry-run fixture on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const WEDGE_COUNT = 5;

describeEmbeddedPostgres("ADR-009 §4.3-b dry-run 5-wedge fixture (NFM-3600)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  const enqueueWakeup = vi.fn();
  const recovery = enqueueWakeup as unknown as Parameters<typeof recoveryService>[1]["enqueueWakeup"];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-adr009-43b-fixture-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip §4.3-b Fixture Co",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Dry-run Bot",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Flag starts OFF; the fixture opts in explicitly per test.
    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: false });
    enqueueWakeup.mockReset();
  });

  afterEach(async () => {
    // Full instanceSettings singleton reset — the §4.3-a flag is persisted in
    // this row's `experimental` JSONB column, and the test previously relied
    // on `updateExperimental({false})` in `beforeEach` to clear stale state
    // across tests. CR (aed30220) flagged a regression where 3/4 cases read
    // `skippedFlagOff=true` even after `updateExperimental({true})` — most
    // plausibly caused by stale JSONB state surviving across cases. Deleting
    // the singleton row eliminates any state-leak class of bugs entirely.
    await db.delete(instanceSettings);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(seed: {
    id: string;
    title: string;
    status: "todo" | "in_progress" | "blocked" | "in_review" | "backlog" | "done" | "cancelled";
  }): Promise<void> {
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

  interface FiveWedgeSeed {
    blockers: string[];
    dependents: string[];
    relations: { blockerId: string; dependentId: string }[];
  }

  /**
   * Seed 5 fake cancelled-blocker wedges:
   *   - 5 blocker issues, each in `cancelled` status
   *   - 5 dependent issues (each carrying exactly 1 cancelled blocker)
   *
   * Returns the IDs so the test can make stable assertions.
   */
  async function seedFiveWedges(): Promise<FiveWedgeSeed> {
    const blockers: string[] = [];
    const dependents: string[] = [];
    const relations: { blockerId: string; dependentId: string }[] = [];

    for (let i = 0; i < WEDGE_COUNT; i += 1) {
      const blockerId = randomUUID();
      const dependentId = randomUUID();
      blockers.push(blockerId);
      dependents.push(dependentId);
      relations.push({ blockerId, dependentId });

      await seedIssue({ id: blockerId, title: `Cancelled blocker ${i + 1}`, status: "cancelled" });
      await seedIssue({ id: dependentId, title: `Dependent ${i + 1}`, status: "blocked" });
      await seedBlocksRelation(blockerId, dependentId);
    }

    return { blockers, dependents, relations };
  }

  async function blockerIdsFor(dependentId: string): Promise<string[]> {
    const rows = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, dependentId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    return rows.map((r) => r.blockerIssueId);
  }

  it("clears all 5 cancelled-blocker wedges when the flag is ON", async () => {
    const { blockers, dependents } = await seedFiveWedges();

    // Sanity: every dependent starts with exactly one blocker.
    for (const depId of dependents) {
      const initial = await blockerIdsFor(depId);
      expect(initial).toHaveLength(1);
    }

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: true });
    const svc = recoveryService(db, { enqueueWakeup: recovery });
    const result = await svc.reconcileBlockedByIssueIds();

    expect(result.skippedFlagOff).toBe(false);
    expect(result.dependentsUpdated).toBe(WEDGE_COUNT);
    expect(result.blockerRelationsRemoved).toBe(WEDGE_COUNT);
    expect(result.removedByStatus.done).toBe(0);
    expect(result.removedByStatus.cancelled).toBe(WEDGE_COUNT);

    // Hard guarantee: every dependent has an EMPTY blockedByIssueIds.
    for (const depId of dependents) {
      const remaining = await blockerIdsFor(depId);
      expect(remaining).toEqual([]);
    }

    // The blocker rows themselves remain — only the relation is removed.
    const blockerRows = await db
      .select()
      .from(issues)
      .where(inArray(issues.id, blockers));
    expect(blockerRows).toHaveLength(WEDGE_COUNT);
    expect(blockerRows.every((r) => r.status === "cancelled")).toBe(true);
  });

  it("is idempotent — a second pass mutates zero rows", async () => {
    await seedFiveWedges();

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: true });
    const svc = recoveryService(db, { enqueueWakeup: recovery });

    const first = await svc.reconcileBlockedByIssueIds();
    expect(first.dependentsUpdated).toBe(WEDGE_COUNT);
    expect(first.blockerRelationsRemoved).toBe(WEDGE_COUNT);

    // Second pass: every relation is already gone, so the scan walks zero
    // rows and the routine short-circuits to a no-op.
    const second = await svc.reconcileBlockedByIssueIds();
    expect(second.skippedFlagOff).toBe(false);
    expect(second.dependentsScanned).toBe(0);
    expect(second.dependentsUpdated).toBe(0);
    expect(second.blockerRelationsRemoved).toBe(0);
    expect(second.removedByStatus.done).toBe(0);
    expect(second.removedByStatus.cancelled).toBe(0);
  });

  it("does NOT yet write audit rows — §4.3-c scope (NFM-3586 / NFM-3594 follow-on)", async () => {
    const { dependents } = await seedFiveWedges();

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: true });
    const svc = recoveryService(db, { enqueueWakeup: recovery });
    await svc.reconcileBlockedByIssueIds();

    // §4.3-a on master (NFM-3584) does not yet write §4.1-shaped audit
    // entries — that lands in §4.3-c (NFM-3586, follow-on reconciliation
    // branched from NFM-3594). When §4.3-c merges, replace this with the
    // FORWARD_LOOKING shape:
    //
    //   const audits = await db.select().from(activityLog)
    //     .where(and(
    //       eq(activityLog.entityType, "issue"),
    //       inArray(activityLog.entityId, dependents),
    //     ));
    //   expect(audits).toHaveLength(WEDGE_COUNT);
    //   for (const a of audits) {
    //     const details = a.details as Record<string, unknown>;
    //     expect(details.routine).toBe("adr009-daily-reconcile");
    //     expect(details.closing_issue_id).toMatch(/^[0-9a-f-]{36}$/i);
    //     expect(details.dependent_id).toMatch(/^[0-9a-f-]{36}$/i);
    //     expect(details.after_blockedByIssueIds).toEqual([]);
    //   }
    //
    // Until then, the §4.3-a routine is silent in the activity log —
    // which is the correct, in-scope behaviour.
    const audits = await db.select().from(activityLog);
    expect(audits).toEqual([]);

    // Sanity: dependents are still cleared, so we know the routine ran.
    for (const depId of dependents) {
      const remaining = await blockerIdsFor(depId);
      expect(remaining).toEqual([]);
    }
    expect(dependents).toHaveLength(WEDGE_COUNT);
  });

  it("is a no-op when the flag is OFF — §4.3-a gate", async () => {
    const { dependents } = await seedFiveWedges();

    await instanceSettingsService(db).updateExperimental({ adr009ReconciliationHookEnabled: false });
    const svc = recoveryService(db, { enqueueWakeup: recovery });
    const result = await svc.reconcileBlockedByIssueIds();

    expect(result.skippedFlagOff).toBe(true);
    expect(result.dependentsScanned).toBe(0);
    expect(result.dependentsUpdated).toBe(0);
    expect(result.blockerRelationsRemoved).toBe(0);

    // Every dependent retains its single cancelled blocker.
    for (const depId of dependents) {
      const remaining = await blockerIdsFor(depId);
      expect(remaining).toHaveLength(1);
    }
  });
});

// WHY THIS FILE EXISTS (companion to `tools/reconcile_cancelled_blockers.py`)
//
// The dry-run script in `tools/reconcile_cancelled_blockers.py` walks the
// live API and reports what `reconcileBlockedByIssueIds` WOULD prune —
// without writing. This Vitest fixture runs the SAME routine against an
// embedded Postgres instance seeded with the canonical 5-wedge pattern
// and verifies the routine's actual on-disk behaviour:
//
//   - terminal blocker relations are deleted
//   - the routine is idempotent
//   - the flag gates the routine (OFF = no-op)
//
// The dry-run script and this fixture together form the §4.3-b AC: ops
// can dry-run the routine against live data before flipping the flag,
// and CI can prove the routine's contract via the embedded test.
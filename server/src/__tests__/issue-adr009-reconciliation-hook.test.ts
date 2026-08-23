import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
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
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";

/**
 * Tests for ADR-009 §4.1-a — Hook entry + reverse-dependent sweep + idempotence guard.
 *
 * Sibling 1 scope:
 *   - Hook runs after `status -> done|cancelled` for every issue transition
 *   - Sweep iterates `issue.blocks` (reverse dependents) and removes the
 *     closing issue's UUID from each dependent's `blockedByIssueIds`
 *   - Idempotent: re-running on an already-reconciled tree is a no-op
 *   - Gated behind `enableAdr009ReconciliationHook` feature flag
 *   - Does NOT auto-transition or wake (those are Sibling 2)
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres ADR-009 reconciliation hook tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("ADR-009 §4.1-a — terminal-transition reverse-dependency sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-adr009-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setupCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function setupPair(companyId: string) {
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Blocker",
        status: "todo",
        priority: "medium",
      },
      {
        id: dependentId,
        companyId,
        title: "Dependent",
        status: "todo",
        priority: "medium",
      },
    ]);
    // Materialise the blocked-by relationship as an issueRelations row:
    // `issueId = blockerId`, `relatedIssueId = dependentId`, type = "blocks".
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: dependentId,
      type: "blocks",
    });
    return { blockerId, dependentId };
  }

  it("clears the closing issue's UUID from each dependent's blockedByIssueIds on terminal transition", async () => {
    const companyId = await setupCompany();
    const { blockerId, dependentId } = await setupPair(companyId);
    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableAdr009ReconciliationHook: true });

    const svc = issueService(db);
    const updated = await svc.update(blockerId, {
      status: "done",
      title: "Blocker (now done)",
    });
    expect(updated?.status).toBe("done");

    const remaining = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.issueId, blockerId),
          eq(issueRelations.relatedIssueId, dependentId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(remaining).toEqual([]);
  });

  it("is idempotent: re-running the sweep on an already-reconciled tree is a no-op", async () => {
    const companyId = await setupCompany();
    const { blockerId, dependentId } = await setupPair(companyId);
    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableAdr009ReconciliationHook: true });

    const svc = issueService(db);
    // First transition: should clear the relation.
    await svc.update(blockerId, { status: "cancelled" });
    // Second transition: the relation is already gone, so the sweep must
    // observe no dependent rows and perform zero DB writes. We assert this
    // indirectly by checking the relation is still absent and the dependent
    // was not touched.
    await svc.update(blockerId, { status: "done" });

    const remaining = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.issueId, blockerId),
          eq(issueRelations.relatedIssueId, dependentId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(remaining).toEqual([]);

    // Dependent must not have been mutated by the sweep (sibling 2 owns the
    // status transition).
    const [dependentAfter] = await db.select().from(issues).where(eq(issues.id, dependentId));
    expect(dependentAfter?.status).toBe("todo");
  });

  it("only clears the closing issue's UUID — other blockers are preserved", async () => {
    const companyId = await setupCompany();
    const closingBlockerId = randomUUID();
    const otherBlockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(issues).values([
      { id: closingBlockerId, companyId, title: "Closing", status: "todo", priority: "medium" },
      { id: otherBlockerId, companyId, title: "Other", status: "todo", priority: "medium" },
      { id: dependentId, companyId, title: "Dependent", status: "todo", priority: "medium" },
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: closingBlockerId, relatedIssueId: dependentId, type: "blocks" },
      { companyId, issueId: otherBlockerId, relatedIssueId: dependentId, type: "blocks" },
    ]);
    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableAdr009ReconciliationHook: true });

    await issueService(db).update(closingBlockerId, { status: "done" });

    // The closing blocker's relation must be gone.
    const closingRelation = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.issueId, closingBlockerId),
          eq(issueRelations.relatedIssueId, dependentId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(closingRelation).toEqual([]);

    // The other blocker's relation must be preserved.
    const otherRelation = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.issueId, otherBlockerId),
          eq(issueRelations.relatedIssueId, dependentId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(otherRelation).toHaveLength(1);
  });

  it("short-circuits when the feature flag is disabled", async () => {
    const companyId = await setupCompany();
    const { blockerId, dependentId } = await setupPair(companyId);
    // Flag stays at the default false value.
    const settings = instanceSettingsService(db);
    const experimental = await settings.getExperimental();
    expect(experimental.enableAdr009ReconciliationHook).toBe(false);

    await issueService(db).update(blockerId, { status: "done" });

    // The relation must NOT have been cleared because the hook was disabled.
    const remaining = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.issueId, blockerId),
          eq(issueRelations.relatedIssueId, dependentId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(remaining).toHaveLength(1);
  });

  it("does not sweep on non-terminal status transitions", async () => {
    const companyId = await setupCompany();
    const { blockerId, dependentId } = await setupPair(companyId);
    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableAdr009ReconciliationHook: true });

    // `in_progress` requires an assignee and `backlog`/`todo` are terminal-noop
    // anyway, so use a transition that is genuinely non-terminal and
    // assignment-free: `blocked`.
    await issueService(db).update(blockerId, { status: "blocked" });

    const remaining = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.issueId, blockerId),
          eq(issueRelations.relatedIssueId, dependentId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(remaining).toHaveLength(1);
  });
});
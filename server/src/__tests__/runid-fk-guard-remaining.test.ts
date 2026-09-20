import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  createDb,
  documentAnnotationThreads,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueTreeHolds,
  issueWatchdogs,
  issues,
  routineDocuments,
  routineRevisions,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { documentService } from "../services/documents.js";
import { documentAnnotationService } from "../services/document-annotations.js";
import { upsertIssueWatchdogForIssue } from "../services/task-watchdogs.js";
import { routineService } from "../services/routines.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";

// NFM-4983 regression (ADR-019 extension rollout): `actor.runId` originates
// from an unvalidated agent JWT `run_id` claim or `x-paperclip-run-id` header
// and may reference no heartbeat_runs row. Before this change the writers
// below wrote it straight into run-id foreign keys and 500'd
// already-succeeded mutations. Every site must probe the run id on the same
// handle and degrade to null — probe only, because each write runs inside a
// transaction (or a dbOrTx shared with in-transaction callers) where a failed
// statement poisons it (25P02) and a belt retry could never succeed.
//
// Covered here (service level; the routes/issues.ts promotion/decision and
// routes/pipelines.ts sites use the identical probe shape):
// - documentService.upsertIssueDocument → document_revisions.created_by_run_id
//   (also backs the issues.ts document-create route)
// - documentAnnotationService.addComment → document_annotation_comments.created_by_run_id
// - upsertIssueWatchdogForIssue → issue_watchdogs.created_by/updated_by_run_id
// - routineService.update description → routine_revisions.created_by_run_id
//   AND document_revisions.created_by_run_id (routine description document)
// - issueTreeControlService.createHold → issue_tree_holds.created_by_run_id
//   (audit addendum: missed by the NFM-4982 audit table)
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres remaining run-id guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("remaining run-id FK guards (NFM-4983)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let issueId: string;
  let realRunId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runid-guard-remaining-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueTreeHolds);
    await db.delete(issueWatchdogs);
    await db.delete(routineRevisions);
    await db.delete(routineDocuments);
    await db.delete(routines);
    await db.delete(documentAnnotationThreads);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(): Promise<void> {
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    realRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ReleaseEngineer",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Run-id guard target",
      status: "todo",
      priority: "medium",
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
      issueNumber: 1,
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: realRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
    });
  }

  it("keeps document revision attribution for a run id that exists", async () => {
    await seed();
    const svc = documentService(db);
    const result = await svc.upsertIssueDocument({
      issueId,
      key: "notes",
      title: "Notes",
      format: "markdown",
      body: "attributed body",
      createdByAgentId: agentId,
      createdByRunId: realRunId,
    });
    expect(result.document.latestRevisionId).not.toBeNull();
    const rows = await db
      .select({ createdByRunId: documentRevisions.createdByRunId })
      .from(documentRevisions)
      .where(eq(documentRevisions.id, result.document.latestRevisionId!));
    expect(rows[0]?.createdByRunId).toBe(realRunId);
  });

  it("degrades a forged run id on document upsert instead of 500ing (document_revisions)", async () => {
    await seed();
    const svc = documentService(db);
    const forgedRunId = randomUUID(); // never inserted into heartbeat_runs
    const result = await svc.upsertIssueDocument({
      issueId,
      key: "notes",
      title: "Notes",
      format: "markdown",
      body: "forged claim body",
      createdByAgentId: agentId,
      createdByRunId: forgedRunId,
    });
    expect(result.document.latestRevisionId).not.toBeNull();
    const revision = await db
      .select({ createdByRunId: documentRevisions.createdByRunId, body: documentRevisions.body })
      .from(documentRevisions)
      .where(eq(documentRevisions.id, result.document.latestRevisionId!));
    expect(revision[0]?.body).toContain("forged claim body");
    expect(revision[0]?.createdByRunId).toBeNull();
  });

  it("degrades a forged run id on a later revision of the same document", async () => {
    await seed();
    const svc = documentService(db);
    const first = await svc.upsertIssueDocument({
      issueId,
      key: "notes",
      format: "markdown",
      body: "first",
      createdByRunId: realRunId,
    });
    const second = await svc.upsertIssueDocument({
      issueId,
      key: "notes",
      format: "markdown",
      body: "second",
      baseRevisionId: first.document.latestRevisionId,
      createdByRunId: randomUUID(), // forged
    });
    const rows = await db
      .select({ createdByRunId: documentRevisions.createdByRunId })
      .from(documentRevisions)
      .where(eq(documentRevisions.id, second.document.latestRevisionId!));
    expect(rows[0]?.createdByRunId).toBeNull();
  });

  it("degrades a forged run id on annotation comments instead of 500ing (document_annotation_comments)", async () => {
    await seed();
    const docs = documentService(db);
    const created = await docs.upsertIssueDocument({
      issueId,
      key: "notes",
      format: "markdown",
      body: "annotated body",
      createdByRunId: realRunId,
    });
    const threadId = randomUUID();
    await db.insert(documentAnnotationThreads).values({
      id: threadId,
      companyId,
      issueId,
      documentId: created.document.id,
      documentKey: "notes",
      originalRevisionId: created.document.latestRevisionId,
      originalRevisionNumber: created.document.latestRevisionNumber,
      currentRevisionId: created.document.latestRevisionId,
      currentRevisionNumber: created.document.latestRevisionNumber,
      selectedText: "annotated",
      normalizedStart: 0,
      normalizedEnd: 9,
      markdownStart: 0,
      markdownEnd: 9,
      anchorSelector: { quote: { exact: "annotated" }, position: { start: 0, end: 9 } },
    });
    const svc = documentAnnotationService(db);
    const comment = await svc.addComment(
      issueId,
      "notes",
      threadId,
      { body: "forged annotation" },
      { actorType: "agent", actorId: agentId, agentId, runId: randomUUID() },
    );
    expect(comment.body).toContain("forged annotation");
    expect(comment.createdByRunId).toBeNull();
    // Valid run still keeps attribution on the same path.
    const attributed = await svc.addComment(
      issueId,
      "notes",
      threadId,
      { body: "attributed annotation" },
      { actorType: "agent", actorId: agentId, agentId, runId: realRunId },
    );
    expect(attributed.createdByRunId).toBe(realRunId);
  });

  it("degrades a forged run id on watchdog upsert (issue_watchdogs create and update)", async () => {
    await seed();
    const created = await upsertIssueWatchdogForIssue(db, companyId, issueId, {
      agentId,
      instructions: "watch",
      actor: { agentId, runId: randomUUID() },
    });
    expect(created.created).toBe(true);
    expect(created.watchdog.createdByRunId).toBeNull();
    expect(created.watchdog.updatedByRunId).toBeNull();

    // Update path through the same probe.
    const updated = await upsertIssueWatchdogForIssue(db, companyId, issueId, {
      agentId,
      instructions: "watch harder",
      actor: { agentId, runId: randomUUID() },
    });
    expect(updated.created).toBe(false);
    expect(updated.watchdog.updatedByRunId).toBeNull();
    expect(updated.watchdog.instructions).toContain("harder");

    // Valid run keeps attribution on the update path.
    const attributed = await upsertIssueWatchdogForIssue(db, companyId, issueId, {
      agentId,
      instructions: "watch valid",
      actor: { agentId, runId: realRunId },
    });
    expect(attributed.watchdog.updatedByRunId).toBe(realRunId);
  });

  it("degrades a forged run id on routine updates (routine_revisions + description document_revisions)", async () => {
    await seed();
    const routineId = randomUUID();
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Guarded routine",
      description: "original description",
      assigneeAgentId: agentId,
    });
    const svc = routineService(db);
    const updated = await svc.update(routineId, { description: "forged description" }, {
      agentId,
      runId: randomUUID(),
    });
    expect(updated?.description).toContain("forged description");
    const revisionRows = await db
      .select({ createdByRunId: routineRevisions.createdByRunId })
      .from(routineRevisions)
      .where(eq(routineRevisions.routineId, routineId));
    expect(revisionRows.length).toBeGreaterThan(0);
    for (const row of revisionRows) {
      expect(row.createdByRunId).toBeNull();
    }
    // The routine description document revision degrades the same way.
    const descriptionRows = await db
      .select({ createdByRunId: documentRevisions.createdByRunId })
      .from(routineDocuments)
      .innerJoin(documents, eq(documents.id, routineDocuments.documentId))
      .innerJoin(documentRevisions, eq(documentRevisions.documentId, documents.id))
      .where(eq(routineDocuments.routineId, routineId));
    expect(descriptionRows.length).toBeGreaterThan(0);
    for (const row of descriptionRows) {
      expect(row.createdByRunId).toBeNull();
    }
  });

  it("keeps routine revision attribution for a run id that exists", async () => {
    await seed();
    const routineId = randomUUID();
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Attributed routine",
      description: "original description",
      assigneeAgentId: agentId,
    });
    const svc = routineService(db);
    await svc.update(routineId, { description: "attributed description" }, {
      agentId,
      runId: realRunId,
    });
    const revisionRows = await db
      .select({ createdByRunId: routineRevisions.createdByRunId })
      .from(routineRevisions)
      .where(eq(routineRevisions.routineId, routineId));
    expect(revisionRows.length).toBeGreaterThan(0);
    expect(revisionRows[0]?.createdByRunId).toBe(realRunId);
  });

  it("degrades a forged run id on subtree holds (issue_tree_holds, audit addendum)", async () => {
    await seed();
    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      title: "Child",
      status: "todo",
      priority: "medium",
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-2`,
      issueNumber: 2,
      parentId: issueId,
    });
    const svc = issueTreeControlService(db);
    const result = await svc.createHold(companyId, issueId, {
      mode: "pause",
      reason: "guard test",
      actor: { actorType: "agent", actorId: agentId, agentId, runId: randomUUID() },
    });
    expect(result.hold.status).toBe("active");
    const rows = await db
      .select({ createdByRunId: issueTreeHolds.createdByRunId })
      .from(issueTreeHolds)
      .where(eq(issueTreeHolds.id, result.hold.id));
    expect(rows[0]?.createdByRunId).toBeNull();

    const attributed = await svc.createHold(companyId, issueId, {
      mode: "pause",
      reason: "guard test valid",
      actor: { actorType: "agent", actorId: agentId, agentId, runId: realRunId },
    });
    expect(attributed.hold.createdByRunId).toBe(realRunId);
  });
});

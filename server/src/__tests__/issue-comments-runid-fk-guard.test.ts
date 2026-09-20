import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

// NFM-4982 regression (ADR-019 extension): `actor.runId` may originate from an
// unvalidated agent JWT `run_id` claim or an `x-paperclip-run-id` header and
// reference no heartbeat_runs row. addComment wrote it straight into
// issue_comments.created_by_run_id, violating
// issue_comments_created_by_run_id_heartbeat_runs_id_fk and 500ing the
// already-succeeded POST /api/issues/:id/comments (routes/issues.ts). The
// write must probe the run id first and degrade to null — the comment row is
// still written, the call never throws for this cause — and the probe→insert
// race is covered by an FK-catch retry without run attribution. The
// tombstone's deleted_by_run_id gets the same probe.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-comments run-id guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Wrapper whose heartbeat_runs probe always reports a hit while every other
 * query (issue lookup, settings reads, inserts) delegates to the real
 * database. Used to simulate the probe→insert race deterministically: the
 * probe passes, the insert still violates the real foreign key.
 */
function deceptiveProbeDb(db: Db, fabricatedRunId: string): Db {
  const wrapper = Object.create(db) as Db;
  (wrapper as unknown as { select: unknown }).select = () => ({
    from: (table: unknown) => {
      if (table === heartbeatRuns) {
        return {
          where: () => ({
            limit: () => ({
              then: (
                onFulfilled: (rows: unknown[]) => unknown,
                onRejected?: (err: unknown) => unknown,
              ) => Promise.resolve([{ id: fabricatedRunId }]).then(onFulfilled, onRejected),
            }),
          }),
        };
      }
      return (db.select() as unknown as { from: (t: unknown) => unknown }).from(table);
    },
  });
  return wrapper;
}

describeEmbeddedPostgres("issue comments run-id FK guard (NFM-4982)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let issueId: string;
  let realRunId: string;
  let svc: ReturnType<typeof issueService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-comments-runid-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
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
      title: "Comment FK guard target",
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

  async function insertedCreatedByRunId(): Promise<string | null | undefined> {
    const rows = await db
      .select({ createdByRunId: issueComments.createdByRunId })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    return rows[0]?.createdByRunId;
  }

  it("keeps attribution for a run id that exists", async () => {
    await seed();
    const comment = await svc.addComment(issueId, "attributed", { agentId, runId: realRunId });
    expect(comment.createdByRunId).toBe(realRunId);
    expect(await insertedCreatedByRunId()).toBe(realRunId);
  });

  it("degrades a forged run id to null instead of 500ing the comment (NFM-4982 repro)", async () => {
    await seed();
    const forgedRunId = randomUUID(); // never inserted into heartbeat_runs
    const comment = await svc.addComment(issueId, "forged claim", { agentId, runId: forgedRunId });
    expect(comment.body).toContain("forged claim");
    expect(await insertedCreatedByRunId()).toBeNull();
  });

  it("passes a null run id through unchanged", async () => {
    await seed();
    await svc.addComment(issueId, "no attribution", { agentId, runId: null });
    expect(await insertedCreatedByRunId()).toBeNull();
  });

  it("retries without attribution when the FK fires after the probe (belt)", async () => {
    await seed();
    const deletedRunId = randomUUID(); // probe lies, insert hits the real FK
    const comment = await svc.addComment(
      issueId,
      "belt retry",
      { agentId, runId: deletedRunId },
      undefined,
      deceptiveProbeDb(db, deletedRunId),
    );
    expect(comment.body).toContain("belt retry");
    expect(await insertedCreatedByRunId()).toBeNull();
  });

  it("tombstones with a forged run id without throwing, dropping the attribution", async () => {
    await seed();
    const created = await svc.addComment(issueId, "to be deleted", { agentId });
    const redacted = await svc.tombstoneComment(created.id, {
      actorType: "agent",
      agentId,
      runId: randomUUID(),
    });
    expect(redacted).not.toBeNull();
    const rows = await db
      .select({ deletedByRunId: issueComments.deletedByRunId, deletedAt: issueComments.deletedAt })
      .from(issueComments)
      .where(eq(issueComments.id, created.id));
    expect(rows[0]?.deletedAt).not.toBeNull();
    expect(rows[0]?.deletedByRunId).toBeNull();
  });

  it("tombstone keeps attribution for a run id that exists", async () => {
    await seed();
    const created = await svc.addComment(issueId, "to be deleted 2", { agentId });
    await svc.tombstoneComment(created.id, { actorType: "agent", agentId, runId: realRunId });
    const rows = await db
      .select({ deletedByRunId: issueComments.deletedByRunId })
      .from(issueComments)
      .where(eq(issueComments.id, created.id));
    expect(rows[0]?.deletedByRunId).toBe(realRunId);
  });
});

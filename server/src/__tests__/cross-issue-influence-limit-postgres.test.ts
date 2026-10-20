import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cross-issue influence limit PostgreSQL serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-issue-cap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows exactly one of concurrent attempts 20 and 21", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Concurrent Coder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: { issueId: sourceIssueId },
    });
    await db.insert(activityLog).values(
      Array.from({ length: 18 }, () => ({
        companyId,
        actorType: "agent" as const,
        actorId: agentId,
        agentId,
        runId,
        action: "issue.cross_issue_influence_observed",
        entityType: "issue",
        entityId: targetIssueId,
      })),
    );

    const input = {
      companyId,
      runId,
      agentId,
      targetIssueId,
      targetIssueIdentifier: "CAP-2",
      kind: "comment" as const,
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    };
    // A comment, a PATCH, and an issue-thread interaction resolution race for the
    // last slot of the shared budget: the row lock must let exactly one of 19/20
    // through per attempt and fail the twenty-first closed.
    const decisions = await Promise.all([
      observeCrossIssueInfluence(db, input),
      observeCrossIssueInfluence(db, { ...input, kind: "update" }),
      observeCrossIssueInfluence(db, { ...input, kind: "interaction_resolution" }),
    ]);

    expect(decisions.map((decision) => decision?.allowed).sort()).toEqual([false, true, true]);
    expect(decisions.map((decision) => decision?.count).sort((a, b) => Number(a) - Number(b)))
      .toEqual([19, 20, 21]);

    const recorded = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_observed")).toHaveLength(20);
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_cap_rejected")).toHaveLength(1);
  });

  it("counts every write of an unassigned board on-demand run against the cap", async () => {
    // NFM-5677: a board on-demand wake snapshot carries wakeReason free text
    // and no issueId/taskId. Such a run must not be denied outright; each
    // write — including to the issue named in wakeReason — spends cap budget.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const targetIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "On-Demand Verifier",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: {
        wakeReason: "NFM-5676: zcode_local external adapter reinstalled; verify dispatch",
        wakeSource: "on_demand",
        triggeredBy: "board",
        wakeTriggerDetail: "manual",
      },
    });

    const base = {
      companyId,
      runId,
      agentId,
      targetIssueId,
      kind: "comment" as const,
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    };
    // Repeating the same target spends budget each time: an unassigned run has
    // no source issue, so no same-issue exemption can apply.
    const first = await observeCrossIssueInfluence(db, base);
    const second = await observeCrossIssueInfluence(db, { ...base, kind: "update" });

    expect(first).toMatchObject({ allowed: true, count: 1 });
    expect(second).toMatchObject({ allowed: true, count: 2 });

    const rows = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.action).toBe("issue.cross_issue_influence_observed");
      expect(row.details).toMatchObject({
        sourceIssueId: null,
        unassignedRun: true,
        targetIssueId,
      });
    }
  });

  it("exempts the named issue and counts other issues for a bound board on-demand run", async () => {
    // NFM-5678: the wakeup route binds contextSnapshot.issueId at dispatch, so
    // the guard sees a source issue: writes to the named issue take the
    // same-issue exemption (no activity row, no budget), everything else
    // still counts. The guard itself is unchanged (NFM-5677).
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const sourceIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Bound Wake Verifier",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: {
        issueId: sourceIssueId,
        taskId: sourceIssueId,
        taskKey: sourceIssueId,
        wakeReason: "NFM-9998: verify dispatch",
        wakeSource: "on_demand",
        triggeredBy: "board",
        wakeTriggerDetail: "manual",
        wakeIssueBindingSource: "reason",
        wakeIssueBindingIdentifier: "NFM-9998",
      },
    });

    const base = {
      companyId,
      runId,
      agentId,
      kind: "comment" as const,
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    };
    const exempt = await observeCrossIssueInfluence(db, { ...base, targetIssueId: sourceIssueId });
    const counted = await observeCrossIssueInfluence(db, {
      ...base,
      targetIssueId: otherIssueId,
      kind: "update",
    });

    expect(exempt).toBeNull();
    expect(counted).toMatchObject({ allowed: true, count: 1 });

    const rows = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "issue.cross_issue_influence_observed",
      details: {
        sourceIssueId,
        unassignedRun: false,
        targetIssueId: otherIssueId,
      },
    });
  });
});

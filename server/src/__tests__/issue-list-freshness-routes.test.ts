import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import {
  __clearIssueListResponseCacheForTests,
  issueRoutes,
} from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue list freshness route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// NFM-5843 AC4: the compact list read path (the only TTL-cached shape) must
// never serve a response older than the latest issue mutation for the same
// company. The frozen-snapshot incident (NFM-5838) made filtered lists miss
// every live issue; these tests pin the same-tick visibility property that
// ADR-008/NFM-2036 requires ("empty result only means truly no matches").
describeEmbeddedPostgres("issue list freshness routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-issue-list-freshness-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    __clearIssueListResponseCacheForTests();
    await db.delete(issues);
    await db.delete(activityLog);
    // Mutations enqueue fire-and-forget heartbeat wakeups whose run_events can
    // land mid-cleanup; retry the pair until the async writer drains.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await db.delete(heartbeatRunEvents);
        await db.delete(heartbeatRuns);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await db.delete(agentRuntimeState);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [
          {
            companyId,
            membershipRole: "owner",
            status: "active",
            principalId: "cloud-user-1",
          },
        ],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  function uniqueIssuePrefix() {
    return `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(
    companyId: string,
    overrides: Partial<typeof issues.$inferInsert> = {},
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Seeded issue ${issueId.slice(0, 8)}`,
      status: "todo",
      priority: "medium",
      updatedAt: new Date(),
      ...overrides,
    });
    return issueId;
  }

  async function listCompact(
    app: express.Express,
    companyId: string,
    query: Record<string, string>,
  ): Promise<{ status: number; ids: string[]; body: any }> {
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ view: "compact", ...query });
    return { status: res.status, ids: (res.body ?? []).map((r: any) => r.id), body: res.body };
  }

  it("AC4-i: shows a just-created issue in unfiltered, status, and assignee filtered compact lists in the same tick", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const existingIssueId = await seedIssue(companyId, {
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const app = createApp(companyId);

    // Warm every cache key the same-tick reads will reuse.
    const warmedUnfiltered = await listCompact(app, companyId, {});
    const warmedStatus = await listCompact(app, companyId, {
      status: "in_progress",
    });
    const warmedAssignee = await listCompact(app, companyId, {
      assigneeAgentId: agentId,
    });
    expect(warmedUnfiltered.ids).toEqual([existingIssueId]);
    expect(warmedStatus.ids).toEqual([existingIssueId]);
    expect(warmedAssignee.ids).toEqual([existingIssueId]);

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Freshly created visibility probe", status: "in_progress", assigneeAgentId: agentId });
    expect([200, 201]).toContain(res.status);
    const createdId = res.body?.id as string;
    expect(createdId).toBeTruthy();

    // Same tick: every shape must already include the new issue.
    const unfiltered = await listCompact(app, companyId, {});
    const statusFiltered = await listCompact(app, companyId, {
      status: "in_progress",
    });
    const assigneeFiltered = await listCompact(app, companyId, {
      assigneeAgentId: agentId,
    });
    expect(unfiltered.ids).toContain(createdId);
    expect(statusFiltered.ids).toContain(createdId);
    expect(assigneeFiltered.ids).toContain(createdId);
  });

  it("AC4-ii: reflects a status change in filtered compact lists immediately", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const movedIssueId = await seedIssue(companyId, { status: "todo" });
    await seedIssue(companyId, { status: "in_progress", assigneeAgentId: agentId });
    const app = createApp(companyId);

    const warmedTodo = await listCompact(app, companyId, { status: "todo" });
    const warmedInProgress = await listCompact(app, companyId, {
      status: "in_progress",
    });
    expect(warmedTodo.ids).toContain(movedIssueId);
    expect(warmedInProgress.ids).not.toContain(movedIssueId);

    const res = await request(app)
      .patch(`/api/issues/${movedIssueId}`)
      .send({ status: "in_progress", assigneeAgentId: agentId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const todoAfter = await listCompact(app, companyId, { status: "todo" });
    const inProgressAfter = await listCompact(app, companyId, {
      status: "in_progress",
    });
    expect(inProgressAfter.ids).toContain(movedIssueId);
    expect(todoAfter.ids).not.toContain(movedIssueId);
  });

  it("AC4-iii: walks offset pages content-monotonically — no duplicates, full coverage, strictly decreasing id order", async () => {
    const companyId = await seedCompany();
    const baseUpdatedAt = new Date("2026-11-01T00:00:00.000Z").getTime();
    const seededIds = new Set<string>();
    for (let index = 0; index < 25; index += 1) {
      seededIds.add(
        await seedIssue(companyId, {
          status: "todo",
          priority: "medium",
          updatedAt: new Date(baseUpdatedAt + index * 60_000),
        }),
      );
    }
    const app = createApp(companyId);

    // Default order: deterministic total order → an offset walk over static
    // data must visit each issue exactly once and never repeat a row.
    const walked: string[] = [];
    for (let offset = 0; offset < 25; offset += 10) {
      const page = await listCompact(app, companyId, {
        limit: "10",
        offset: String(offset),
      });
      expect(page.status).toBe(200);
      walked.push(...page.ids);
    }
    expect(new Set(walked).size).toBe(walked.length);
    expect(new Set(walked)).toEqual(seededIds);

    // Repeating the walk must reproduce the exact same content sequence.
    const walkedAgain: string[] = [];
    for (let offset = 0; offset < 25; offset += 10) {
      const page = await listCompact(app, companyId, {
        limit: "10",
        offset: String(offset),
      });
      walkedAgain.push(...page.ids);
    }
    expect(walkedAgain).toEqual(walked);

    // sortField=id desc: newest id never regresses across page boundaries.
    const idWalked: string[] = [];
    for (let offset = 0; offset < 25; offset += 10) {
      const page = await listCompact(app, companyId, {
        sortField: "id",
        sortDir: "desc",
        limit: "10",
        offset: String(offset),
      });
      idWalked.push(...page.ids);
    }
    expect(new Set(idWalked)).toEqual(seededIds);
    for (let index = 1; index < idWalked.length; index += 1) {
      expect(idWalked[index - 1] > idWalked[index]).toBe(true);
    }
  });
});

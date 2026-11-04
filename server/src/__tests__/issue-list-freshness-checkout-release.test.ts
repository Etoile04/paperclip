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
import { __resetIssueListFreshnessForTests } from "../lib/issue-list-freshness.js";
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
    `Skipping embedded Postgres checkout/release freshness tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// NFM-5850 AC1: the list-freshness watermark hooks introduced for
// svc.create/createChild/update/remove/importIssues (NFM-5843) do not cover
// svc.checkout, svc.release, svc.adminForceRelease, or direct
// `.update(issues)` sites. These tests pin the same-tick visibility property
// across exactly those paths: an assignee flip or status flip must be
// visible in assignee- and status-filtered compact lists on the next read.
describeEmbeddedPostgres(
  "issue list freshness checkout/release/adminForceRelease",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-issue-list-freshness-co",
      );
      db = createDb(tempDb.connectionString);
      // Embedded Postgres boot can exceed the suite's 30s hookTimeout on a
      // loaded host; give it explicit headroom instead of the 20s default.
    }, 60_000);

    afterEach(async () => {
      __clearIssueListResponseCacheForTests();
      __resetIssueListFreshnessForTests();
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
      // The fire-and-forget wakeup writer can still be inserting runtime
      // state / wakeup rows mid-cleanup; retry until it drains.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await db.delete(agentRuntimeState);
          await db.delete(agentWakeupRequests);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
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
      return {
        status: res.status,
        ids: (res.body ?? []).map((r: any) => r.id),
        body: res.body,
      };
    }

    it("AC1-i: an svc.release assignee/status flip is visible same-tick in status- and assignee-filtered compact lists", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId, {
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      const app = createApp(companyId);

      // Warm every cache key the same-tick reads will reuse.
      const warmedInProgress = await listCompact(app, companyId, {
        status: "in_progress",
      });
      const warmedAssignee = await listCompact(app, companyId, {
        assigneeAgentId: agentId,
      });
      const warmedTodo = await listCompact(app, companyId, { status: "todo" });
      expect(warmedInProgress.ids).toEqual([issueId]);
      expect(warmedAssignee.ids).toEqual([issueId]);
      expect(warmedTodo.ids).toEqual([]);

      const res = await request(app).post(`/api/issues/${issueId}/release`);
      expect(res.status).toBe(200);
      expect(res.body?.status).toBe("todo");
      expect(res.body?.assigneeAgentId).toBeNull();

      const seenInProgress = await listCompact(app, companyId, {
        status: "in_progress",
      });
      const seenAssignee = await listCompact(app, companyId, {
        assigneeAgentId: agentId,
      });
      const seenTodo = await listCompact(app, companyId, { status: "todo" });
      expect(seenInProgress.ids).toEqual([]);
      expect(seenAssignee.ids).toEqual([]);
      expect(seenTodo.ids).toEqual([issueId]);
    });

    it("AC1-ii: an svc.checkout flip (direct .update(issues) site) is visible same-tick in status- and assignee-filtered compact lists", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId, { status: "todo" });
      const app = createApp(companyId);

      const warmedTodo = await listCompact(app, companyId, {
        status: "todo",
      });
      const warmedAssignee = await listCompact(app, companyId, {
        assigneeAgentId: agentId,
      });
      const warmedInProgress = await listCompact(app, companyId, {
        status: "in_progress",
      });
      expect(warmedTodo.ids).toEqual([issueId]);
      expect(warmedAssignee.ids).toEqual([]);
      expect(warmedInProgress.ids).toEqual([]);

      const res = await request(app)
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId, expectedStatuses: ["todo"] });
      expect(res.status).toBe(200);
      expect(res.body?.status).toBe("in_progress");
      expect(res.body?.assigneeAgentId).toBe(agentId);

      const seenTodo = await listCompact(app, companyId, { status: "todo" });
      const seenAssignee = await listCompact(app, companyId, {
        assigneeAgentId: agentId,
      });
      const seenInProgress = await listCompact(app, companyId, {
        status: "in_progress",
      });
      expect(seenTodo.ids).toEqual([]);
      expect(seenAssignee.ids).toEqual([issueId]);
      expect(seenInProgress.ids).toEqual([issueId]);
    });

    it("AC1-iii: an adminForceRelease flip (clearAssignee) is visible same-tick in status- and assignee-filtered compact lists", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId, {
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      const app = createApp(companyId);

      const warmedInProgress = await listCompact(app, companyId, {
        status: "in_progress",
      });
      const warmedAssignee = await listCompact(app, companyId, {
        assigneeAgentId: agentId,
      });
      expect(warmedInProgress.ids).toEqual([issueId]);
      expect(warmedAssignee.ids).toEqual([issueId]);

      const res = await request(app)
        .post(`/api/issues/${issueId}/admin/force-release`)
        .query({ clearAssignee: "true" });
      expect(res.status).toBe(200);
      expect(res.body?.issue?.assigneeAgentId).toBeNull();

      // adminForceRelease clears leases + (here) the assignee but does NOT
      // flip status, so membership in the in_progress list is unchanged —
      // what must be fresh is the assignee-filtered membership and the
      // served payload (lease columns cleared, not the pre-release snapshot).
      const seenInProgress = await listCompact(app, companyId, {
        status: "in_progress",
      });
      const seenAssignee = await listCompact(app, companyId, {
        assigneeAgentId: agentId,
      });
      expect(seenAssignee.ids).toEqual([]);
      expect(seenInProgress.ids).toEqual([issueId]);
      expect(seenInProgress.body?.[0]?.checkoutRunId).toBeNull();
      expect(seenInProgress.body?.[0]?.executionRunId).toBeNull();
      expect(seenInProgress.body?.[0]?.assigneeAgentId).toBeNull();
    });
  },
);

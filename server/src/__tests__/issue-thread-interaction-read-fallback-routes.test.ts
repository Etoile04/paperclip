/**
 * NFM-4978 D2 — route-level read tolerance for malformed interaction results.
 *
 * Regression guard for the NFM-4974 poisoning: out-of-band expiry writers
 * stored `result` rows outside the shared schemas, so `hydrateInteraction`
 * threw and `GET /api/issues/:id/interactions` permanently 400-ed. These
 * tests seed the poisoned fixture rows straight into the database and assert
 * the real route answers 200 with the read-time fallback result.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyMemberships,
  createDb,
  goals,
  issueComments,
  issueRelations,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import {
  __resetInteractionResultFallbackMetricsForTests,
  snapshotInteractionResultFallbackMetrics,
} from "../metrics/interaction-result-fallback.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres interaction read-fallback route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue thread interaction read fallback routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-interaction-read-fallback-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
    __resetInteractionResultFallbackMetricsForTests();
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
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null }));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithIssue() {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `F${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
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
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Read fallback goal",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Issue with poisoned interactions",
      status: "in_progress",
      priority: "medium",
    });

    return { companyId, issueId };
  }

  it("returns 200 with the auto_expired fallback for a malformed expired result row", async () => {
    const { companyId, issueId } = await seedCompanyWithIssue();

    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "expired",
      payload: { version: 1, prompt: "Ship the canary?" },
      result: { version: 1, outcome: "auto_expired_healer" },
      resolvedAt: new Date(),
    });

    const response = await request(createApp(companyId)).get(`/api/issues/${issueId}/interactions`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      kind: "request_confirmation",
      status: "expired",
      result: {
        version: 1,
        outcome: "auto_expired",
        reason: expect.stringContaining("read-time fallback (raw="),
      },
    });

    const snapshot = await snapshotInteractionResultFallbackMetrics();
    expect(snapshot["request_confirmation"]).toBe(1);
  });

  it("returns 200 with result null for a malformed result on a pending row", async () => {
    const { companyId, issueId } = await seedCompanyWithIssue();

    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Still pending?" },
      result: { version: 1, outcome: "auto_expired_healer" },
    });

    const response = await request(createApp(companyId)).get(`/api/issues/${issueId}/interactions`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      kind: "request_confirmation",
      status: "pending",
      result: null,
    });
  });
});

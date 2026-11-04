import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  goals,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import { connectionIntentService } from "../services/connection-intents.js";
import {
  isSyntheticConnectionIntentAddressee,
  resolveConnectionIntentAddressee,
} from "../services/connection-intent-addressee.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("isSyntheticConnectionIntentAddressee", () => {
  it("flags the board principal and nothing else", () => {
    expect(isSyntheticConnectionIntentAddressee("local-board")).toBe(true);
    expect(isSyntheticConnectionIntentAddressee(randomUUID())).toBe(false);
    expect(isSyntheticConnectionIntentAddressee(null)).toBe(false);
    expect(isSyntheticConnectionIntentAddressee(undefined)).toBe(false);
  });
});

describeEmbeddedPostgres("connection intent addressee resolution", () => {
  let db!: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;

  const HUMAN_A = "11111111-1111-4111-8111-111111111111";
  const HUMAN_B = "22222222-2222-4222-8222-222222222222";
  const OPERATOR = "33333333-3333-4333-8333-333333333333";

  beforeAll(async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-intent-addressee-");
    cleanup = tempDb.cleanup;
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await cleanup?.();
  });

  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(goals);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  async function seedCompany(humans: Array<{ id: string; joinedAt: Date; status?: string }>) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Addressee tests",
      issuePrefix: `ADDR-${randomUUID().slice(0, 8)}`,
      requireBoardApprovalForNewAgents: false,
    });
    // The board principal is always a member in local_trusted installs.
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "local-board",
      status: "active",
      membershipRole: "owner",
    });
    for (const human of humans) {
      await db.insert(authUsers).values({
        id: human.id,
        name: `Human ${human.id.slice(0, 4)}`,
        email: `${human.id.slice(0, 8)}@example.com`,
        createdAt: human.joinedAt,
        updatedAt: human.joinedAt,
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: human.id,
        status: human.status ?? "active",
        membershipRole: "member",
        createdAt: human.joinedAt,
      });
    }
    return companyId;
  }

  it("re-addresses a synthetic responsible user to the earliest-joined active human", async () => {
    // HUMAN_B joined first even though HUMAN_A has the lexicographically
    // smaller id — membership createdAt, not id order, decides.
    const companyId = await seedCompany([
      { id: HUMAN_A, joinedAt: new Date("2026-01-02T00:00:00Z") },
      { id: HUMAN_B, joinedAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const resolved = await resolveConnectionIntentAddressee(db, companyId, "local-board");
    expect(resolved).toEqual({ addresseeUserId: HUMAN_B, routedFromUserId: "local-board" });
  });

  it("keeps a real human responsible user unchanged", async () => {
    const companyId = await seedCompany([
      { id: HUMAN_A, joinedAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const resolved = await resolveConnectionIntentAddressee(db, companyId, HUMAN_A);
    expect(resolved).toEqual({ addresseeUserId: HUMAN_A, routedFromUserId: null });
  });

  it("falls back to the original value when the company has no human member", async () => {
    const companyId = await seedCompany([]);
    const resolved = await resolveConnectionIntentAddressee(db, companyId, "local-board");
    expect(resolved).toEqual({ addresseeUserId: "local-board", routedFromUserId: null });
  });

  it("skips inactive members when choosing a human addressee", async () => {
    const companyId = await seedCompany([
      { id: HUMAN_A, joinedAt: new Date("2026-01-01T00:00:00Z"), status: "revoked" },
      { id: HUMAN_B, joinedAt: new Date("2026-02-01T00:00:00Z") },
    ]);
    const resolved = await resolveConnectionIntentAddressee(db, companyId, "local-board");
    expect(resolved).toEqual({ addresseeUserId: HUMAN_B, routedFromUserId: "local-board" });
  });

  it("breaks membership timestamp ties deterministically by user id", async () => {
    const joinedAt = new Date("2026-01-01T00:00:00Z");
    const companyId = await seedCompany([
      { id: HUMAN_B, joinedAt },
      { id: HUMAN_A, joinedAt },
    ]);
    const resolved = await resolveConnectionIntentAddressee(db, companyId, "local-board");
    expect(resolved).toEqual({ addresseeUserId: HUMAN_A, routedFromUserId: "local-board" });
  });

  async function seedIntentCompany() {
    const companyId = await seedCompany([
      { id: OPERATOR, joinedAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const agentId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Connect a service",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Researcher",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Read Notion",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    return { companyId, agentId };
  }

  function intentClaims(companyId: string, agentId: string, runId: string): RuntimeToolsTokenClaims {
    return {
      sub: agentId,
      company_id: companyId,
      run_id: runId,
      responsible_user_id: "local-board",
      scope: "connection_intents",
      iat: 1,
      exp: 2,
      instance_id: "test",
    };
  }

  async function seedRunFor(companyId: string, agentId: string) {
    const runId = randomUUID();
    const issueId = (await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId)))[0]!.id;
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "local-board",
      contextSnapshot: { issueId },
    });
    return intentClaims(companyId, agentId, runId);
  }

  it("creation addresses the card to the human operator and records provenance", async () => {
    const { companyId, agentId } = await seedIntentCompany();
    const claims = await seedRunFor(companyId, agentId);
    const service = connectionIntentService(db);
    const created = await service.request(claims, "notion");
    const [row] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, created.interactionId!));
    expect(row).toMatchObject({
      kind: "connection_intent",
      addresseeUserId: OPERATOR,
      status: "pending",
    });
    expect(row?.payload).toMatchObject({ routedFromUserId: "local-board" });
  });

  it("creation reuses the same card when the same request retries", async () => {
    const { companyId, agentId } = await seedIntentCompany();
    const claims = await seedRunFor(companyId, agentId);
    const service = connectionIntentService(db);
    const created = await service.request(claims, "notion");
    const repeated = await service.request(claims, "notion");
    expect(repeated.interactionId).toBe(created.interactionId);
    const pending = await db.select().from(issueThreadInteractions).where(
      eq(issueThreadInteractions.addresseeUserId, OPERATOR),
    );
    expect(pending).toHaveLength(1);
  });
});

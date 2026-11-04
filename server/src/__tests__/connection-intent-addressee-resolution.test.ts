import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  goals,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/index.js";
import { connectionIntentBoardRoutes } from "../routes/connection-intents.js";
import {
  connectionIntentService,
  resolveConnectionIntentAddressee,
} from "../services/connection-intents.js";
import { migrateLocalBoardConnectionIntentAddressees } from "../services/connection-intent-addressee-migration.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SENTINEL = "local-board";

/** Seed one real human: an authUsers login row plus an active company membership. */
async function seedHuman(
  db: ReturnType<typeof createDb>,
  companyId: string,
  userId: string,
  joinedAt: Date,
  membershipRole: "member" | "viewer" = "member",
) {
  await db.insert(authUsers).values({
    id: userId,
    name: userId,
    email: `${userId}@example.test`,
    emailVerified: true,
    image: null,
    createdAt: joinedAt,
    updatedAt: joinedAt,
  }).onConflictDoNothing();
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole,
    createdAt: joinedAt,
    updatedAt: joinedAt,
  });
}

/**
 * Mirror `ensureLocalTrustedBoardPrincipal`: on local_trusted installs the
 * synthetic board principal has BOTH an auth row and an active membership, so
 * "who is human" cannot be derived from table presence alone. The auth row is
 * instance-global bootstrap data, so the insert tolerates existing rows.
 */
async function seedSentinel(db: ReturnType<typeof createDb>, companyId: string, joinedAt: Date) {
  await db.insert(authUsers).values({
    id: SENTINEL,
    name: "Board",
    email: "local@paperclip.local",
    emailVerified: true,
    image: null,
    createdAt: joinedAt,
    updatedAt: joinedAt,
  }).onConflictDoNothing();
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: SENTINEL,
    status: "active",
    membershipRole: "admin",
    createdAt: joinedAt,
    updatedAt: joinedAt,
  });
}

/** Seed a goal + issue so interaction rows can satisfy their foreign keys. */
async function seedIssue(db: ReturnType<typeof createDb>, companyId: string): Promise<string> {
  const goalId = randomUUID();
  const issueId = randomUUID();
  await db.insert(goals).values({
    id: goalId,
    companyId,
    title: "Legacy connection card host",
    level: "task",
    status: "active",
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    goalId,
    title: "Legacy connection card",
    status: "in_progress",
    priority: "medium",
  });
  return issueId;
}

async function seedTask(db: ReturnType<typeof createDb>, companyId: string, responsibleUserId: string) {
  const agentId = randomUUID();
  const goalId = randomUUID();
  const issueId = randomUUID();
  const runId = randomUUID();
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
  await db.insert(goals).values({
    id: goalId,
    companyId,
    title: "Connect a service",
    level: "task",
    status: "active",
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
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId,
    status: "running",
    responsibleUserId,
    contextSnapshot: { issueId },
  });
  const claims: RuntimeToolsTokenClaims = {
    sub: agentId,
    company_id: companyId,
    run_id: runId,
    responsible_user_id: responsibleUserId,
    scope: "connection_intents",
    iat: 1,
    exp: 2,
    instance_id: "test",
  };
  return { agentId, issueId, runId, claims };
}

describeEmbeddedPostgres("connection intent addressee resolution", () => {
  let db!: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;
  let companyWithHumans!: string;
  let companyWithoutHumans!: string;
  let earlyHuman!: string;
  let lateHuman!: string;
  let lateViewer!: string;
  let sentinelTask!: Awaited<ReturnType<typeof seedTask>>;
  let humanTask!: Awaited<ReturnType<typeof seedTask>>;
  let noHumansIssueId!: string;

  beforeAll(async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-conn-addressee-");
    cleanup = tempDb.cleanup;
    db = createDb(tempDb.connectionString);

    companyWithHumans = randomUUID();
    await db.insert(companies).values({
      id: companyWithHumans,
      name: "Humans here",
      issuePrefix: "HUM",
      requireBoardApprovalForNewAgents: false,
    });
    earlyHuman = "human-early";
    lateHuman = "human-late";
    const joinedEarly = new Date("2026-01-01T00:00:00Z");
    const joinedLate = new Date("2026-06-01T00:00:00Z");
    await seedSentinel(db, companyWithHumans, new Date("2025-01-01T00:00:00Z"));
    await seedHuman(db, companyWithHumans, earlyHuman, joinedEarly);
    await seedHuman(db, companyWithHumans, lateHuman, joinedLate);
    // A read-only member who joined last: candidates must never pick them.
    lateViewer = "human-late-viewer";
    await seedHuman(db, companyWithHumans, lateViewer, new Date("2026-09-01T00:00:00Z"), "viewer");
    sentinelTask = await seedTask(db, companyWithHumans, SENTINEL);
    humanTask = await seedTask(db, companyWithHumans, earlyHuman);

    companyWithoutHumans = randomUUID();
    await db.insert(companies).values({
      id: companyWithoutHumans,
      name: "No humans",
      issuePrefix: "NOH",
      requireBoardApprovalForNewAgents: false,
    });
    await seedSentinel(db, companyWithoutHumans, new Date("2025-01-01T00:00:00Z"));
    noHumansIssueId = await seedIssue(db, companyWithoutHumans);
  }, 20_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("reroutes a non-human responsible user to the earliest-joined human member", async () => {
    await expect(resolveConnectionIntentAddressee(db, companyWithHumans, SENTINEL)).resolves.toBe(earlyHuman);
  });

  it("keeps a real human responsible user unchanged", async () => {
    await expect(resolveConnectionIntentAddressee(db, companyWithHumans, lateHuman)).resolves.toBe(lateHuman);
    await expect(resolveConnectionIntentAddressee(db, companyWithHumans, earlyHuman)).resolves.toBe(earlyHuman);
  });

  it("falls back to the original addressee when the company has no human members", async () => {
    await expect(resolveConnectionIntentAddressee(db, companyWithoutHumans, SENTINEL)).resolves.toBe(SENTINEL);
  });

  it("skips an earliest-joined viewer and picks the completable member instead", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Viewer joined first",
      issuePrefix: "VWF",
      requireBoardApprovalForNewAgents: false,
    });
    await seedSentinel(db, companyId, new Date("2025-01-01T00:00:00Z"));
    // The viewer joined earlier, so the pre-NFM-5852 ordering would pick them —
    // but viewers fail the addressed-user completeness guard and are never
    // delivered a wake, so selecting one recreates the black hole.
    await seedHuman(db, companyId, "viewer-early", new Date("2026-01-01T00:00:00Z"), "viewer");
    await seedHuman(db, companyId, "member-late", new Date("2026-06-01T00:00:00Z"), "member");
    await expect(resolveConnectionIntentAddressee(db, companyId, SENTINEL)).resolves.toBe("member-late");
  });

  it("falls back to the original addressee when the only humans are viewers", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Viewers only",
      issuePrefix: "VON",
      requireBoardApprovalForNewAgents: false,
    });
    await seedSentinel(db, companyId, new Date("2025-01-01T00:00:00Z"));
    await seedHuman(db, companyId, "viewer-only", new Date("2026-01-01T00:00:00Z"), "viewer");
    await expect(resolveConnectionIntentAddressee(db, companyId, SENTINEL)).resolves.toBe(SENTINEL);
  });

  it("reroutes a viewer responsible user instead of passing them through", async () => {
    // The creation path rejects viewer responsible users before the resolver
    // runs, so this pins the resolver's own contract: it never returns a
    // member who cannot complete the card, even when that member is the
    // responsible user itself.
    await expect(resolveConnectionIntentAddressee(db, companyWithHumans, lateViewer)).resolves.toBe(earlyHuman);
  });

  it("is deterministic when two humans joined at the same instant", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Tie company",
      issuePrefix: "TIE",
      requireBoardApprovalForNewAgents: false,
    });
    const sameInstant = new Date("2026-03-03T00:00:00Z");
    await seedHuman(db, companyId, "zzz-tie", sameInstant);
    await seedHuman(db, companyId, "aaa-tie", sameInstant);
    await expect(resolveConnectionIntentAddressee(db, companyId, SENTINEL)).resolves.toBe("aaa-tie");
  });

  it("creates agent-originated intents addressed to the resolved human with provenance", async () => {
    const service = connectionIntentService(db);
    const created = await service.request(sentinelTask.claims, "notion");
    const [row] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, created.interactionId!));
    expect(row).toMatchObject({
      kind: "connection_intent",
      addresseeUserId: earlyHuman,
      status: "pending",
    });
    expect(row?.payload).toMatchObject({ routedFromUserId: SENTINEL });
    const repeated = await service.request(sentinelTask.claims, "notion");
    expect(repeated.interactionId).toBe(created.interactionId);
  });

  it("creates human-originated intents unchanged without provenance", async () => {
    const service = connectionIntentService(db);
    const created = await service.request(humanTask.claims, "notion");
    const [row] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, created.interactionId!));
    expect(row).toMatchObject({
      kind: "connection_intent",
      addresseeUserId: earlyHuman,
      status: "pending",
    });
    expect((row?.payload as Record<string, unknown>).routedFromUserId).toBeUndefined();
  });

  describe("board-route addressee enforcement", () => {
    function appWithActor(actor: Record<string, unknown>) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { actor: Record<string, unknown> }).actor = actor;
        next();
      });
      app.use(connectionIntentBoardRoutes(db, { wakeup: vi.fn() } as never));
      app.use(errorHandler);
      return app;
    }

    it("turns agent identities away from the board complete endpoint", async () => {
      const service = connectionIntentService(db);
      const created = await service.request(sentinelTask.claims, "slack");
      const agentActor = {
        type: "agent",
        agentId: sentinelTask.agentId,
        source: "runtime",
      };
      const response = await request(appWithActor(agentActor))
        .post(`/connection-intents/${created.interactionId}/complete`)
        .send({ connectionId: randomUUID() });
      expect(response.status).toBe(403);
    });

    it("keeps the strict addressee match for board principals", async () => {
      const service = connectionIntentService(db);
      const created = await service.request(sentinelTask.claims, "linear");
      const boardActor = { type: "board", userId: lateHuman, source: "session", companyIds: [companyWithHumans] };
      const response = await request(appWithActor(boardActor))
        .post(`/connection-intents/${created.interactionId}/complete`)
        .send({ connectionId: randomUUID() });
      expect(response.status).toBe(403);
    });

    it("lets the addressed human complete through the board route", async () => {
      const service = connectionIntentService(db);
      const created = await service.request(sentinelTask.claims, "notion");
      const [application] = await db.insert(toolApplications).values({
        companyId: companyWithHumans,
        applicationKey: `notion-${randomUUID()}`,
        name: "Notion",
        type: "mcp_http",
        status: "active",
        metadata: { sourceTemplateKey: "notion" },
      }).returning();
      const [connection] = await db.insert(toolConnections).values({
        companyId: companyWithHumans,
        applicationId: application!.id,
        name: "Early human's Notion",
        uid: `notion/${randomUUID()}`,
        transport: "mcp_remote",
        authKind: "api_key",
        credentialPolicy: "per_user",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: { sourceTemplateKey: "notion" },
        transportConfig: { sourceTemplateKey: "notion" },
      }).returning();
      await db.insert(connectionGrants).values({
        companyId: companyWithHumans,
        connectionId: connection!.id,
        kind: "user",
        subjectUserId: earlyHuman,
        status: "active",
        isDefault: false,
      });
      // Completion re-validates that the agent keeps permitted tools on the
      // connection, mirroring the existing service test's fixture.
      const [profile] = await db.insert(toolProfiles).values({ companyId: companyWithHumans, name: "Notion reads", profileKey: "notion-reads", defaultAction: "allow", status: "active" }).returning();
      await db.insert(toolProfileBindings).values({ companyId: companyWithHumans, profileId: profile!.id, targetType: "agent", targetId: sentinelTask.agentId });
      await db.insert(toolCatalogEntries).values({ companyId: companyWithHumans, connectionId: connection!.id, toolName: "notion-read", name: "notion-read", versionHash: "fixture-v1", status: "active", entryKind: "tool" });
      const addressedActor = { type: "board", userId: earlyHuman, source: "session", companyIds: [companyWithHumans] };
      const response = await request(appWithActor(addressedActor))
        .post(`/connection-intents/${created.interactionId}/complete`)
        .send({ connectionId: connection!.id });
      expect(response.status, response.text).toBe(200);
    });
  });

  describe("legacy local-board migration", () => {
    async function insertLegacyPendingRow(companyId: string, issueId: string, payloadOverride?: unknown) {
      const [row] = await db.insert(issueThreadInteractions).values({
        companyId,
        issueId,
        kind: "connection_intent",
        status: "pending",
        continuationPolicy: "wake_assignee",
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
        resolverPolicyProvenance: "explicit",
        effectiveResolverPolicySource: "governed_action",
        idempotencyKey: `legacy:${randomUUID()}`,
        sourceRunId: sentinelTask.runId,
        originCommentIds: [],
        title: "Connect Notion",
        summary: "Researcher needs this connection to continue.",
        createdByAgentId: sentinelTask.agentId,
        addresseeUserId: SENTINEL,
        // Tests seeding corrupt data pass payloads that violate the column's
        // declared type on purpose: drifted deployed schemas contain exactly
        // such rows, and the migration must classify them defensively. The
        // override check must distinguish `undefined` from `null` — `null` is
        // itself one of the corrupt shapes under test.
        payload: (payloadOverride === undefined ? {
          version: 1,
          serviceSlug: "notion",
          serviceName: "Notion",
          requestingAgentId: sentinelTask.agentId,
          requestingAgentName: "Researcher",
          phase: "requested",
        } : payloadOverride) as typeof issueThreadInteractions.$inferInsert["payload"],
      }).returning();
      return row!;
    }

    it("re-points pending local-board cards at the resolved human and records provenance", async () => {
      const legacy = await insertLegacyPendingRow(companyWithHumans, sentinelTask.issueId);
      const result = await migrateLocalBoardConnectionIntentAddressees(db, { backupPath: null });
      expect(result.changes).toContainEqual(expect.objectContaining({
        interactionId: legacy.id,
        from: SENTINEL,
        to: earlyHuman,
      }));
      const [after] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, legacy.id));
      expect(after).toMatchObject({ addresseeUserId: earlyHuman, status: "pending" });
      expect(after?.payload).toMatchObject({ routedFromUserId: SENTINEL });
    });

    it("is idempotent: a second pass changes nothing", async () => {
      await insertLegacyPendingRow(companyWithHumans, sentinelTask.issueId);
      const first = await migrateLocalBoardConnectionIntentAddressees(db, { backupPath: null });
      expect(first.migrated).toBeGreaterThan(0);
      const second = await migrateLocalBoardConnectionIntentAddressees(db, { backupPath: null });
      expect(second.changes).toEqual([]);
      expect(second.migrated).toBe(0);
    });

    it("leaves cards in companies without human members untouched", async () => {
      const stranded = await insertLegacyPendingRow(companyWithoutHumans, noHumansIssueId);
      const result = await migrateLocalBoardConnectionIntentAddressees(db, { backupPath: null });
      expect(result.changes).not.toContainEqual(expect.objectContaining({ interactionId: stranded.id }));
      const [after] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, stranded.id));
      expect(after).toMatchObject({ addresseeUserId: SENTINEL });
    });

    it("never touches resolved (non-pending) cards", async () => {
      const [resolved] = await db.insert(issueThreadInteractions).values({
        companyId: companyWithHumans,
        issueId: sentinelTask.issueId,
        kind: "connection_intent",
        status: "accepted",
        continuationPolicy: "wake_assignee",
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
        resolverPolicyProvenance: "explicit",
        effectiveResolverPolicySource: "governed_action",
        idempotencyKey: `legacy-resolved:${randomUUID()}`,
        sourceRunId: sentinelTask.runId,
        originCommentIds: [],
        title: "Connect Notion",
        summary: "Researcher needs this connection to continue.",
        createdByAgentId: sentinelTask.agentId,
        addresseeUserId: SENTINEL,
        payload: {
          version: 1,
          serviceSlug: "notion",
          serviceName: "Notion",
          requestingAgentId: sentinelTask.agentId,
          requestingAgentName: "Researcher",
          phase: "requested",
        },
      }).returning();
      await migrateLocalBoardConnectionIntentAddressees(db, { backupPath: null });
      const [after] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, resolved!.id));
      expect(after).toMatchObject({ addresseeUserId: SENTINEL, status: "accepted" });
    });

    it("skips corrupt and NULL payload rows without counting or backing them up", async () => {
      // Drifted deployed schemas predate the payload NOT NULL constraint, so
      // real NULL payloads are the surface this guard exists for; relax it in
      // this throwaway database before seeding one.
      await db.execute(sql`ALTER TABLE issue_thread_interactions ALTER COLUMN payload DROP NOT NULL`);
      const good = await insertLegacyPendingRow(companyWithHumans, sentinelTask.issueId);
      const nullRow = await insertLegacyPendingRow(companyWithHumans, sentinelTask.issueId, null);
      const arrayRow = await insertLegacyPendingRow(companyWithHumans, sentinelTask.issueId, [{ version: 1 }]);
      const stringRow = await insertLegacyPendingRow(companyWithHumans, sentinelTask.issueId, "not-a-payload");
      const backupPath = path.join(mkdtempSync(path.join(os.tmpdir(), "nfm-5853-backup-")), "backup.jsonl");
      const corruptIds = [nullRow.id, arrayRow.id, stringRow.id];

      const result = await migrateLocalBoardConnectionIntentAddressees(db, { backupPath });

      expect(result.skippedCorruptPayload).toBe(3);
      expect(result.migrated).toBe(1);
      expect(result.changes).toEqual([
        expect.objectContaining({ interactionId: good.id, from: SENTINEL, to: earlyHuman }),
      ]);
      for (const id of corruptIds) {
        expect(result.changes).not.toContainEqual(expect.objectContaining({ interactionId: id }));
      }
      // The backup records only genuinely migrated rows: exactly one line,
      // the good row, none of the corrupt ones.
      expect(existsSync(backupPath)).toBe(true);
      const backupText = readFileSync(backupPath, "utf8");
      expect(backupText.split("\n").filter((line) => line.trim() !== "")).toHaveLength(1);
      expect(backupText).toContain(good.id);
      for (const id of corruptIds) {
        expect(backupText).not.toContain(id);
      }
      const [afterGood] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, good.id));
      expect(afterGood).toMatchObject({ addresseeUserId: earlyHuman, status: "pending" });
      expect(afterGood?.payload).toMatchObject({ routedFromUserId: SENTINEL });
      const [afterNull] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, nullRow.id));
      expect(afterNull).toMatchObject({ addresseeUserId: SENTINEL, status: "pending", payload: null });

      // Idempotent: the corrupt rows are skipped again, nothing new migrates.
      const second = await migrateLocalBoardConnectionIntentAddressees(db, { backupPath: null });
      expect(second.changes).toEqual([]);
      expect(second.migrated).toBe(0);
      expect(second.skippedCorruptPayload).toBe(3);
    });

    it("dry-run reports only migratable rows and writes nothing", async () => {
      const nullRow = await insertLegacyPendingRow(companyWithHumans, sentinelTask.issueId, null);
      const good = await insertLegacyPendingRow(companyWithHumans, sentinelTask.issueId);
      const backupPath = path.join(mkdtempSync(path.join(os.tmpdir(), "nfm-5853-dryrun-")), "backup.jsonl");

      const result = await migrateLocalBoardConnectionIntentAddressees(db, { dryRun: true, backupPath });

      expect(result.changes).toEqual([
        expect.objectContaining({ interactionId: good.id, from: SENTINEL, to: earlyHuman }),
      ]);
      expect(result.migrated).toBe(0);
      // The three corrupt rows seeded by the test above are still pending.
      expect(result.skippedCorruptPayload).toBeGreaterThanOrEqual(1);
      // Dry-run never writes: no backup file, no database change.
      expect(existsSync(backupPath)).toBe(false);
      const [afterGood] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, good.id));
      expect(afterGood).toMatchObject({ addresseeUserId: SENTINEL, status: "pending" });
      expect(afterGood?.payload).not.toMatchObject({ routedFromUserId: SENTINEL });
      const [afterNull] = await db.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, nullRow.id));
      expect(afterNull).toMatchObject({ addresseeUserId: SENTINEL, payload: null });

      // Clean scope (nothing migratable): 0 changes, exactly as before.
      const cleanRun = await migrateLocalBoardConnectionIntentAddressees(db, {
        companyId: companyWithoutHumans,
        dryRun: true,
        backupPath: null,
      });
      expect(cleanRun.changes).toEqual([]);
      expect(cleanRun.migrated).toBe(0);
    });
  });
});

describe("resolveConnectionIntentAddressee module surface", () => {
  it("is exported for creation-time routing and migration reuse", () => {
    expect(typeof resolveConnectionIntentAddressee).toBe("function");
  });
});

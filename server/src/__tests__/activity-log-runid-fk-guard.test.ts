import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
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
import { logActivity } from "../services/activity-log.js";

// NFM-4977 regression (ADR-019): `actor.runId` may originate from an
// unvalidated agent JWT `run_id` claim or an `x-paperclip-run-id` header and
// reference no heartbeat_runs row. Writing it to activity_log violates
// activity_log_run_id_heartbeat_runs_id_fk and 500s an already-succeeded
// operation. logActivity must probe the run id first and degrade to null —
// the activity row is still written, the call never throws for this cause,
// and the probe→insert race (run deleted in between) is covered by an
// FK-catch retry without run attribution.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity-log run-id guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Wrapper whose heartbeat_runs probe always reports a hit while every other
 * query (settings reads, inserts) delegates to the real database. Used to
 * simulate the probe→insert race deterministically: the probe passes, the
 * insert still violates the real foreign key.
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

describeEmbeddedPostgres("activity log run-id FK guard (NFM-4977)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let realRunId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-log-runid-");
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

  async function seed(): Promise<void> {
    companyId = randomUUID();
    agentId = randomUUID();
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
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: realRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
    });
  }

  async function insertedRunIds(action: string): Promise<(string | null)[]> {
    const rows = await db
      .select({ runId: activityLog.runId })
      .from(activityLog)
      .where(eq(activityLog.action, action));
    return rows.map((row) => row.runId);
  }

  it("keeps run attribution when the run id references a real heartbeat run", async () => {
    await seed();
    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: realRunId,
      action: "test.valid_run",
      entityType: "issue",
      entityId: randomUUID(),
    });
    expect(await insertedRunIds("test.valid_run")).toEqual([realRunId]);
  });

  it("degrades a forged JWT run_id claim to null instead of throwing (NFM-4977)", async () => {
    await seed();
    const forgedRunId = randomUUID(); // never inserted into heartbeat_runs
    await expect(
      logActivity(db, {
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId: forgedRunId,
        action: "test.forged_run",
        entityType: "issue_comment",
        entityId: randomUUID(),
      }),
    ).resolves.toBeUndefined();
    expect(await insertedRunIds("test.forged_run")).toEqual([null]);
  });

  it("still writes the activity row when runId is absent (baseline)", async () => {
    await seed();
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: randomUUID(),
      runId: null,
      action: "test.null_run",
      entityType: "issue",
      entityId: randomUUID(),
    });
    expect(await insertedRunIds("test.null_run")).toEqual([null]);
  });

  it("retries without run attribution when the insert hits the run_id FK after the probe passed", async () => {
    await seed();
    const deletedMidFlightRunId = randomUUID(); // probe says exists, insert FK fails
    const deceptive = deceptiveProbeDb(db, deletedMidFlightRunId);
    await expect(
      logActivity(deceptive, {
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId: deletedMidFlightRunId,
        action: "test.race_belt",
        entityType: "issue",
        entityId: randomUUID(),
      }),
    ).resolves.toBeUndefined();
    // Exactly one row persisted, without run attribution — no throw, no dupe.
    expect(await insertedRunIds("test.race_belt")).toEqual([null]);
  });
});

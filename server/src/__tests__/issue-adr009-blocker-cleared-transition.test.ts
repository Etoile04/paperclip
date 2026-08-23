import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
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
 * Tests for ADR-009 §4.1-b — Auto-transition + Paperclip wake.
 *
 * Sibling 2 scope:
 *   - When the closing issue's relation row is removed AND the dependent
 *     has no remaining blockers (`after == []`) AND the dependent's status
 *     is currently `blocked`, transition the dependent to:
 *       - `in_progress` if it has a `checkoutRunId` (an active run owns it)
 *       - `todo`      otherwise
 *   - Emit a Paperclip heartbeat wake to `dependent.assigneeAgentId` via
 *     the existing `enqueueWakeup` primitive (DI-injected).
 *   - Conditional: NO transition and NO wake when `after != []` or
 *     `dependent.status != "blocked"`.
 *
 * These tests pass a mock `enqueueWakeup` into the `issueService` factory
 * so we can assert wake payload/idempotency without booting the heartbeat
 * service. They do NOT cover the actual wake insertion into
 * `agentWakeupRequests` (that is exercised by sibling 3's audit/log work
 * and the existing heartbeat integration tests).
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres ADR-009 blocker-cleared-transition tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type WakeCall = {
  agentId: string;
  opts: {
    source?: string;
    triggerDetail?: string | null;
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
  };
};

function makeWakeRecorder() {
  const calls: WakeCall[] = [];
  const fn = async (agentId: string, opts: WakeCall["opts"] = {}) => {
    calls.push({ agentId, opts });
  };
  return { fn, calls };
}

describeEmbeddedPostgres("ADR-009 §4.1-b — auto-transition blocked → todo|in_progress + wake", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-adr009-transition-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
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

  async function setupAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "worker",
      role: "worker",
      status: "idle",
      adapterType: "codex_local",
    });
    return agentId;
  }

  async function setupHeartbeatRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
    });
    return runId;
  }

  async function setupPairWithDependent(opts: {
    companyId: string;
    dependentStatus: "blocked" | "todo" | "in_progress";
    dependentAssigneeAgentId: string | null;
    dependentCheckoutRunId?: string | null;
    extraBlocker?: boolean;
  }) {
    const blockerId = randomUUID();
    const otherBlockerId = randomUUID();
    const dependentId = randomUUID();

    await db.insert(issues).values([
      {
        id: blockerId,
        companyId: opts.companyId,
        title: "Blocker",
        status: "todo",
        priority: "medium",
      },
      {
        id: dependentId,
        companyId: opts.companyId,
        title: "Dependent",
        status: opts.dependentStatus,
        priority: "medium",
        assigneeAgentId: opts.dependentAssigneeAgentId,
        checkoutRunId: opts.dependentCheckoutRunId ?? null,
      },
    ]);

    if (opts.extraBlocker) {
      await db.insert(issues).values({
        id: otherBlockerId,
        companyId: opts.companyId,
        title: "OtherBlocker",
        status: "todo",
        priority: "medium",
      });
    }

    await db.insert(issueRelations).values({
      companyId: opts.companyId,
      issueId: blockerId,
      relatedIssueId: dependentId,
      type: "blocks",
    });

    if (opts.extraBlocker) {
      await db.insert(issueRelations).values({
        companyId: opts.companyId,
        issueId: otherBlockerId,
        relatedIssueId: dependentId,
        type: "blocks",
      });
    }

    return { blockerId, otherBlockerId: opts.extraBlocker ? otherBlockerId : null, dependentId };
  }

  it("transitions a blocked dependent with no checkout to todo when its only blocker closes", async () => {
    const companyId = await setupCompany();
    const agentId = await setupAgent(companyId);
    const { blockerId, dependentId } = await setupPairWithDependent({
      companyId,
      dependentStatus: "blocked",
      dependentAssigneeAgentId: agentId,
      dependentCheckoutRunId: null,
    });

    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableAdr009ReconciliationHook: true });

    const wake = makeWakeRecorder();
    await issueService(db, { enqueueWakeup: wake.fn }).update(blockerId, { status: "done" });

    const [dependentAfter] = await db.select().from(issues).where(eq(issues.id, dependentId));
    expect(dependentAfter?.status).toBe("todo");

    expect(wake.calls).toHaveLength(1);
    expect(wake.calls[0]?.agentId).toBe(agentId);
    expect(wake.calls[0]?.opts.source).toBe("automation");
    expect(wake.calls[0]?.opts.reason).toBe("adr-009-blocker-cleared");
    expect(wake.calls[0]?.opts.payload).toMatchObject({
      issueId: dependentId,
      trigger: "adr-009-§4.1-b",
      closingIssueId: blockerId,
    });
    expect(wake.calls[0]?.opts.idempotencyKey).toBe(
      `adr-009:§4.1-b:${dependentId}:${blockerId}`,
    );
  });

  it("transitions a blocked dependent with an active checkout to in_progress", async () => {
    const companyId = await setupCompany();
    const agentId = await setupAgent(companyId);
    const checkoutRunId = await setupHeartbeatRun(companyId, agentId);
    const { blockerId, dependentId } = await setupPairWithDependent({
      companyId,
      dependentStatus: "blocked",
      dependentAssigneeAgentId: agentId,
      dependentCheckoutRunId: checkoutRunId,
    });

    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableAdr009ReconciliationHook: true });

    const wake = makeWakeRecorder();
    await issueService(db, { enqueueWakeup: wake.fn }).update(blockerId, { status: "cancelled" });

    const [dependentAfter] = await db.select().from(issues).where(eq(issues.id, dependentId));
    expect(dependentAfter?.status).toBe("in_progress");
    // The active checkoutRunId MUST be preserved across the auto-transition.
    expect(dependentAfter?.checkoutRunId).toBe(checkoutRunId);

    expect(wake.calls).toHaveLength(1);
    expect(wake.calls[0]?.agentId).toBe(agentId);
    expect(wake.calls[0]?.opts.payload).toMatchObject({
      issueId: dependentId,
      trigger: "adr-009-§4.1-b",
      closingIssueId: blockerId,
    });
  });

  it("does NOT transition or wake when other blockers remain", async () => {
    const companyId = await setupCompany();
    const agentId = await setupAgent(companyId);
    const { blockerId, dependentId } = await setupPairWithDependent({
      companyId,
      dependentStatus: "blocked",
      dependentAssigneeAgentId: agentId,
      extraBlocker: true,
    });

    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableAdr009ReconciliationHook: true });

    const wake = makeWakeRecorder();
    await issueService(db, { enqueueWakeup: wake.fn }).update(blockerId, { status: "done" });

    const [dependentAfter] = await db.select().from(issues).where(eq(issues.id, dependentId));
    expect(dependentAfter?.status).toBe("blocked");

    // No wake should be queued because the dependent is still blocked by
    // the remaining blocker.
    expect(wake.calls).toEqual([]);

    // The other blocker's relation must still be present.
    const otherRelations = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, dependentId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(otherRelations).toHaveLength(1);
  });

  it("does NOT transition or wake when the dependent is not in blocked status", async () => {
    const companyId = await setupCompany();
    const agentId = await setupAgent(companyId);
    const { blockerId, dependentId } = await setupPairWithDependent({
      companyId,
      dependentStatus: "todo",
      dependentAssigneeAgentId: agentId,
    });

    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableAdr009ReconciliationHook: true });

    const wake = makeWakeRecorder();
    await issueService(db, { enqueueWakeup: wake.fn }).update(blockerId, { status: "done" });

    const [dependentAfter] = await db.select().from(issues).where(eq(issues.id, dependentId));
    expect(dependentAfter?.status).toBe("todo");
    expect(wake.calls).toEqual([]);
  });

  it("does NOT wake when the dependent has no assignee (still transitions to todo)", async () => {
    const companyId = await setupCompany();
    const { blockerId, dependentId } = await setupPairWithDependent({
      companyId,
      dependentStatus: "blocked",
      dependentAssigneeAgentId: null,
    });

    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableAdr009ReconciliationHook: true });

    const wake = makeWakeRecorder();
    await issueService(db, { enqueueWakeup: wake.fn }).update(blockerId, { status: "done" });

    // Even without an assignee, the dependent must still be transitioned
    // out of `blocked` so the work can be picked up later. No wake fires
    // because there is no agentId to wake.
    const [dependentAfter] = await db.select().from(issues).where(eq(issues.id, dependentId));
    expect(dependentAfter?.status).toBe("todo");
    expect(wake.calls).toEqual([]);
  });

  it("does NOT transition or wake when the feature flag is disabled", async () => {
    const companyId = await setupCompany();
    const agentId = await setupAgent(companyId);
    const { blockerId, dependentId } = await setupPairWithDependent({
      companyId,
      dependentStatus: "blocked",
      dependentAssigneeAgentId: agentId,
    });

    // Flag stays at default false.
    const wake = makeWakeRecorder();
    await issueService(db, { enqueueWakeup: wake.fn }).update(blockerId, { status: "done" });

    const [dependentAfter] = await db.select().from(issues).where(eq(issues.id, dependentId));
    expect(dependentAfter?.status).toBe("blocked");
    expect(wake.calls).toEqual([]);

    // The relation row must still be present too (sibling 1's sweep was
    // also disabled).
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

  it("is idempotent on re-transition: re-running on an already-cleared dependent is a no-op", async () => {
    const companyId = await setupCompany();
    const agentId = await setupAgent(companyId);
    const { blockerId, dependentId } = await setupPairWithDependent({
      companyId,
      dependentStatus: "blocked",
      dependentAssigneeAgentId: agentId,
    });

    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableAdr009ReconciliationHook: true });

    const wake = makeWakeRecorder();
    const svc = issueService(db, { enqueueWakeup: wake.fn });

    // First close: dependent transitions blocked -> todo and a wake is queued.
    await svc.update(blockerId, { status: "done" });
    expect(wake.calls).toHaveLength(1);

    // Second close (already done): sweep sees no relation rows for this
    // (blocker, dependent) pair, so it must not transition the dependent
    // again and must not queue a second wake.
    await svc.update(blockerId, { status: "done" });
    expect(wake.calls).toHaveLength(1);

    const [dependentAfter] = await db.select().from(issues).where(eq(issues.id, dependentId));
    expect(dependentAfter?.status).toBe("todo");
  });
});

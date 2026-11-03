import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createIssueListFreshnessMetrics,
  getIssueListFreshnessMetrics,
} from "../metrics/issue-list-freshness.js";
import {
  ISSUE_LIST_FRESHNESS_CANARY_ASSIGNEE_A_ID,
  ISSUE_LIST_FRESHNESS_CANARY_ASSIGNEE_B_ID,
  ISSUE_LIST_FRESHNESS_CANARY_COMPANY_ID,
  ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS,
  createIssueListFreshnessCanaryCore,
  resolveIssueListFreshnessCanaryIntervalMs,
} from "../services/issue-list-freshness-canary.js";
import { issueService } from "../services/issues.js";

// NFM-5843 AC2: an in-server canary writes a sentinel row every tick and
// reads it back through the SAME list query shape the incident froze. A
// visibility lag beyond 10s must emit a WARN log and increment a Prometheus
// breach counter — demonstrably, from this suite.
describe("issue list freshness canary core", () => {
  function makeLogger() {
    const calls: { level: string; payload: unknown; message: string }[] = [];
    return {
      calls,
      warn: (payload: unknown, message: string) =>
        calls.push({ level: "warn", payload, message }),
      info: (payload: unknown, message: string) =>
        calls.push({ level: "info", payload, message }),
      error: (payload: unknown, message: string) =>
        calls.push({ level: "error", payload, message }),
    };
  }

  function makeReadBack() {
    const state = { visible: false };
    const readBack = async (nonce: string) =>
      state.visible ? { nonce } : null;
    return { state, readBack };
  }

  // Healthy field legs for the widened tick: the sentinel is visible only
  // under the assignee the last write set, with the projected value equal to
  // it — mirroring what a real healthy PG serves through
  // `issues_company_assignee_status_idx`.
  function makeHealthyFieldModel() {
    const state = { currentAssignee: null as string | null };
    const writeSentinel = async (
      _title: string,
      _at: Date,
      assigneeAgentId: string,
    ) => {
      state.currentAssignee = assigneeAgentId;
    };
    const readBackByAssignee = async (
      nonce: string,
      assigneeAgentId: string,
    ) =>
      assigneeAgentId === state.currentAssignee
        ? {
            title: `issue-list-freshness-canary nonce=${nonce}`,
            assigneeAgentId: state.currentAssignee,
          }
        : null;
    return { state, writeSentinel, readBackByAssignee };
  }

  it("reports a fresh tick when the read-back sees the sentinel write in the same tick", async () => {
    const logger = makeLogger();
    const { state, readBack } = makeReadBack();
    state.visible = true;
    const fieldModel = makeHealthyFieldModel();
    const metrics = createIssueListFreshnessMetrics();
    let nowMs = 1_000;
    const core = createIssueListFreshnessCanaryCore({
      db: {} as any,
      ensureSentinel: async () => {},
      logger,
      metrics,
      now: () => nowMs,
      readBack,
      readBackByAssignee: fieldModel.readBackByAssignee,
      writeSentinel: fieldModel.writeSentinel,
    });

    const result = await core.tick();

    expect(result.outcome).toBe("fresh");
    expect(result.lagMs).toBeLessThan(ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS);
    expect(logger.calls.filter((c) => c.level === "warn")).toHaveLength(0);
    expect((await metrics.snapshot()).ticksFresh).toBe(1);
    expect((await metrics.snapshot()).breaches).toBe(0);
  });

  it("warns once and increments the breach counter when visibility lag exceeds the threshold", async () => {
    const logger = makeLogger();
    const { readBack } = makeReadBack();
    const metrics = createIssueListFreshnessMetrics();
    let nowMs = 1_000;
    const core = createIssueListFreshnessCanaryCore({
      db: {} as any,
      ensureSentinel: async () => {},
      logger,
      metrics,
      now: () => nowMs,
      readBack,
      writeSentinel: async () => {},
    });

    // Tick 1: write lands, read-back misses immediately (lag ~0, no warn yet).
    const first = await core.tick();
    expect(first.outcome).toBe("lagging");
    expect(logger.calls.filter((c) => c.level === "warn")).toHaveLength(0);

    // Tick 2 past the threshold: WARN + breach metric.
    nowMs += ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS + 1_000;
    const second = await core.tick();
    expect(second.outcome).toBe("lagging");
    expect(second.lagMs).toBeGreaterThan(ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS);
    const warns = logger.calls.filter((c) => c.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain("list freshness");
    expect((warns[0].payload as any).lagMs).toBeGreaterThan(
      ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS,
    );
    expect((await metrics.snapshot()).breaches).toBe(1);

    // Tick 3 still invisible: no duplicate warn for the same stuck write.
    nowMs += 1_000;
    await core.tick();
    expect(logger.calls.filter((c) => c.level === "warn")).toHaveLength(1);
    expect((await metrics.snapshot()).breaches).toBe(1);
    expect((await metrics.snapshot()).ticksLagging).toBe(3);
  });

  it("clears the anchor and logs recovery once the sentinel becomes visible again", async () => {
    const logger = makeLogger();
    const { state, readBack } = makeReadBack();
    const fieldModel = makeHealthyFieldModel();
    const metrics = createIssueListFreshnessMetrics();
    let nowMs = 1_000;
    const core = createIssueListFreshnessCanaryCore({
      db: {} as any,
      ensureSentinel: async () => {},
      logger,
      metrics,
      now: () => nowMs,
      readBack,
      readBackByAssignee: fieldModel.readBackByAssignee,
      writeSentinel: fieldModel.writeSentinel,
    });

    await core.tick();
    nowMs += ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS + 5_000;
    await core.tick();
    expect((await metrics.snapshot()).breaches).toBe(1);

    state.visible = true;
    nowMs += 1_000;
    const recovered = await core.tick();
    expect(recovered.outcome).toBe("fresh");
    const infos = logger.calls.filter((c) => c.level === "info");
    expect(infos.some((c) => c.message.includes("recovered"))).toBe(true);
    // Anchor cleared: the next stuck write starts a fresh warning cycle.
    state.visible = false;
    nowMs += 1_000;
    await core.tick(); // fresh stuck write, lag ~0, no breach yet
    nowMs += ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS + 1_000;
    await core.tick(); // overdue observation → second breach
    expect((await metrics.snapshot()).breaches).toBe(2);
  });

  it("flips the sentinel assignee every tick and checks membership, projected value, and old-assignee absence", async () => {
    const logger = makeLogger();
    const metrics = createIssueListFreshnessMetrics();
    let nowMs = 1_000;
    // Healthy model: the row is visible only under the just-written assignee,
    // and the projected value equals it (field_old short-circuits to null).
    const writes: { nonce: string; assignee: string }[] = [];
    const state = { currentAssignee: null as string | null };
    const fieldReadCalls: string[] = [];
    const core = createIssueListFreshnessCanaryCore({
      db: {} as any,
      ensureSentinel: async () => {},
      logger,
      metrics,
      now: () => nowMs,
      readBack: async () => ({ nonce: "seen" }),
      readBackByAssignee: async (nonce, assigneeAgentId) => {
        fieldReadCalls.push(assigneeAgentId);
        if (assigneeAgentId !== state.currentAssignee) return null;
        return {
          title: `issue-list-freshness-canary nonce=${nonce}`,
          assigneeAgentId: state.currentAssignee,
        };
      },
      writeSentinel: async (title, _at, assignee) => {
        const marker = "nonce=";
        writes.push({
          nonce: title.slice(title.indexOf(marker) + marker.length),
          assignee,
        });
        state.currentAssignee = assignee;
      },
    });

    const first = await core.tick();
    expect(first.outcome).toBe("fresh");
    const second = await core.tick();
    expect(second.outcome).toBe("fresh");
    const third = await core.tick();
    expect(third.outcome).toBe("fresh");

    // The assignee alternates between the two fixed canary agents.
    const assignees = writes.map((w) => w.assignee);
    expect(new Set(assignees).size).toBe(2);
    expect(assignees[1]).not.toBe(assignees[0]);
    expect(assignees[2]).toBe(assignees[0]);
    // Fresh nonces every tick — each write re-anchors existence.
    expect(new Set(writes.map((w) => w.nonce)).size).toBe(3);
    // First tick has no previous assignee: no field_old read happened.
    expect(fieldReadCalls.slice(0, 1)).toEqual([assignees[0]]);
    expect(logger.calls.filter((c) => c.level === "warn")).toHaveLength(0);
    expect((await metrics.snapshot()).breaches).toBe(0);
  });

  it("flags field_new (with WARN + breach once) when the projected assignee value stays stale, then recovers", async () => {
    const logger = makeLogger();
    const metrics = createIssueListFreshnessMetrics();
    let nowMs = 1_000;
    // The row is visible under the just-written assignee, but the projected
    // value lags behind the write — the 21:05Z stale-btree-content class.
    const state = {
      currentAssignee: null as string | null,
      projectedAssignee: null as string | null,
    };
    const core = createIssueListFreshnessCanaryCore({
      db: {} as any,
      ensureSentinel: async () => {},
      logger,
      metrics,
      now: () => nowMs,
      readBack: async () => ({ nonce: "seen" }),
      readBackByAssignee: async (nonce, assigneeAgentId) => {
        if (assigneeAgentId !== state.currentAssignee) return null;
        return {
          title: `issue-list-freshness-canary nonce=${nonce}`,
          assigneeAgentId: state.projectedAssignee ?? state.currentAssignee,
        };
      },
      writeSentinel: async (_title, _at, assignee) => {
        state.currentAssignee = assignee;
        // Deliberately does NOT advance projectedAssignee: stale projection.
      },
    });

    // Tick 1 lands healthy (first write, no stale projection to trip over).
    const first = await core.tick();
    expect(first.outcome).toBe("fresh");
    state.projectedAssignee = state.currentAssignee; // value A is durable

    // Tick 2 flips to B but the projected value stays A → field_new fails.
    nowMs += 1_000;
    const second = await core.tick();
    expect(second.outcome).toBe("lagging");
    expect(second.leg).toBe("field_new");
    expect(logger.calls.filter((c) => c.level === "warn")).toHaveLength(0);

    // Past the threshold: WARN names the leg, breach counter increments once.
    nowMs += ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS + 1_000;
    const third = await core.tick();
    expect(third.outcome).toBe("lagging");
    expect(third.leg).toBe("field_new");
    const warns = logger.calls.filter((c) => c.level === "warn");
    expect(warns).toHaveLength(1);
    expect((warns[0].payload as any).leg).toBe("field_new");
    expect((await metrics.snapshot()).breaches).toBe(1);

    // Projection catches up: all legs pass, recovery is logged, anchor clears.
    state.projectedAssignee = state.currentAssignee;
    nowMs += 1_000;
    const recovered = await core.tick();
    expect(recovered.outcome).toBe("fresh");
    expect(
      logger.calls
        .filter((c) => c.level === "info")
        .some((c) => c.message.includes("recovered")),
    ).toBe(true);
  });

  it("flags field_old when the sentinel still appears under the previous assignee", async () => {
    const logger = makeLogger();
    const metrics = createIssueListFreshnessMetrics();
    let nowMs = 1_000;
    // Stale index range: after the flip the row is visible under BOTH the
    // new and the previous assignee.
    const state = {
      currentAssignee: null as string | null,
      alsoVisibleUnder: null as string | null,
    };
    const core = createIssueListFreshnessCanaryCore({
      db: {} as any,
      ensureSentinel: async () => {},
      logger,
      metrics,
      now: () => nowMs,
      readBack: async () => ({ nonce: "seen" }),
      readBackByAssignee: async (nonce, assigneeAgentId) => {
        if (
          assigneeAgentId !== state.currentAssignee &&
          assigneeAgentId !== state.alsoVisibleUnder
        ) {
          return null;
        }
        return {
          title: `issue-list-freshness-canary nonce=${nonce}`,
          assigneeAgentId: state.currentAssignee,
        };
      },
      writeSentinel: async (_title, _at, assignee) => {
        state.alsoVisibleUnder = state.currentAssignee; // old range lingers
        state.currentAssignee = assignee;
      },
    });

    const first = await core.tick();
    expect(first.outcome).toBe("fresh"); // no previous assignee yet
    state.alsoVisibleUnder = null;

    // Tick 2 flips; the old assignee's index range still returns the row.
    nowMs += 1_000;
    const second = await core.tick();
    expect(second.outcome).toBe("lagging");
    expect(second.leg).toBe("field_old");
    expect(logger.calls.filter((c) => c.level === "warn")).toHaveLength(0);

    // Recovery once the old range drains.
    state.alsoVisibleUnder = null;
    nowMs += 1_000;
    const recovered = await core.tick();
    expect(recovered.outcome).toBe("fresh");
    expect(logger.calls.filter((c) => c.level === "warn")).toHaveLength(0);
  });

  it("resolves the canary interval from env, defaulting to 15s and clamping to the ≤30s charter bound", () => {
    expect(resolveIssueListFreshnessCanaryIntervalMs({})).toBe(15_000);
    expect(
      resolveIssueListFreshnessCanaryIntervalMs({
        PAPERCLIP_LIST_FRESHNESS_CANARY_INTERVAL_MS: "5000",
      }),
    ).toBe(5_000);
    expect(
      resolveIssueListFreshnessCanaryIntervalMs({
        PAPERCLIP_LIST_FRESHNESS_CANARY_INTERVAL_MS: "999999",
      }),
    ).toBe(30_000);
    expect(
      resolveIssueListFreshnessCanaryIntervalMs({
        PAPERCLIP_LIST_FRESHNESS_CANARY_INTERVAL_MS: "off",
      }),
    ).toBeNull();
    expect(
      resolveIssueListFreshnessCanaryIntervalMs({
        PAPERCLIP_LIST_FRESHNESS_CANARY_INTERVAL_MS: "0",
      }),
    ).toBeNull();
    expect(
      resolveIssueListFreshnessCanaryIntervalMs({
        PAPERCLIP_LIST_FRESHNESS_CANARY_INTERVAL_MS: "not-a-number",
      }),
    ).toBe(15_000);
  });

  it("exposes the breach counter through the prometheus render surface", async () => {
    const metrics = createIssueListFreshnessMetrics();
    const logger = makeLogger();
    const { readBack } = makeReadBack();
    let nowMs = 0;
    const core = createIssueListFreshnessCanaryCore({
      db: {} as any,
      ensureSentinel: async () => {},
      logger,
      metrics,
      now: () => nowMs,
      readBack,
      writeSentinel: async () => {},
    });
    await core.tick();
    nowMs += ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS + 1_000;
    await core.tick();

    const rendered = await metrics.render();
    expect(rendered).toContain("paperclip_issue_list_freshness_tick_total");
    expect(rendered).toContain(
      "paperclip_issue_list_freshness_visibility_lag_breaches_total 1",
    );
  });
});

const describeEmbeddedPostgres = (
  await getEmbeddedPostgresTestSupport()
).supported
  ? describe
  : describe.skip;

if (!(await getEmbeddedPostgresTestSupport()).supported) {
  console.warn("Skipping embedded Postgres canary integration tests on this host");
}

describeEmbeddedPostgres("issue list freshness canary integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-issue-list-canary-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("writes + reads back the sentinel through the real list query shapes, reflects the assignee flip, and never leaks into other companies", async () => {
    const realCompanyId = randomUUID();
    await db.insert(companies).values({
      id: realCompanyId,
      name: "Paperclip",
      issuePrefix: "RCAN",
      requireBoardApprovalForNewAgents: false,
    });

    const svc = issueService(db);
    const core = createIssueListFreshnessCanaryCore({
      db,
      logger: console,
      metrics: getIssueListFreshnessMetrics(),
    });

    const first = await core.tick();
    expect(first.outcome).toBe("fresh");

    const second = await core.tick();
    expect(second.outcome).toBe("fresh");

    // The sentinel row is visible through the status-filtered list shape and
    // its updatedAt advanced (fresh index entries every tick).
    const sentinelRows = await svc.list(ISSUE_LIST_FRESHNESS_CANARY_COMPANY_ID, {
      status: "in_progress",
    });
    expect(sentinelRows).toHaveLength(1);
    expect(sentinelRows[0].title).toContain("issue-list-freshness-canary");

    // Field-update reflection: tick 1 assigned A, tick 2 flipped to B. The
    // assignee-filtered shape must show the row under B (projected value ==
    // B) and nowhere under A — the 21:05Z recurrence class.
    const underA = await svc.list(ISSUE_LIST_FRESHNESS_CANARY_COMPANY_ID, {
      assigneeAgentId: ISSUE_LIST_FRESHNESS_CANARY_ASSIGNEE_A_ID,
    });
    const underB = await svc.list(ISSUE_LIST_FRESHNESS_CANARY_COMPANY_ID, {
      assigneeAgentId: ISSUE_LIST_FRESHNESS_CANARY_ASSIGNEE_B_ID,
    });
    expect(underA).toHaveLength(0);
    expect(underB).toHaveLength(1);
    expect(underB[0].assigneeAgentId).toBe(
      ISSUE_LIST_FRESHNESS_CANARY_ASSIGNEE_B_ID,
    );
    expect(underB[0].title).toContain("issue-list-freshness-canary");

    // Isolation: the sentinel (and its assignee agents) never appear in
    // another company's lists — including assignee-filtered reads.
    const realRows = await svc.list(realCompanyId, {});
    expect(realRows).toHaveLength(0);
    const realStatusRows = await svc.list(realCompanyId, {
      status: "in_progress",
    });
    expect(realStatusRows).toHaveLength(0);
    const realUnderCanaryA = await svc.list(realCompanyId, {
      assigneeAgentId: ISSUE_LIST_FRESHNESS_CANARY_ASSIGNEE_A_ID,
    });
    const realUnderCanaryB = await svc.list(realCompanyId, {
      assigneeAgentId: ISSUE_LIST_FRESHNESS_CANARY_ASSIGNEE_B_ID,
    });
    expect(realUnderCanaryA).toHaveLength(0);
    expect(realUnderCanaryB).toHaveLength(0);
  });
});

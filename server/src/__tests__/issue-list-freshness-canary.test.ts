import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createIssueListFreshnessMetrics,
  getIssueListFreshnessMetrics,
} from "../metrics/issue-list-freshness.js";
import {
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

  it("reports a fresh tick when the read-back sees the sentinel write in the same tick", async () => {
    const logger = makeLogger();
    const { state, readBack } = makeReadBack();
    state.visible = true;
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
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("writes + reads back the sentinel through the real list query shape and never leaks into other companies", async () => {
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

    // Isolation: the sentinel never appears in another company's lists.
    const realRows = await svc.list(realCompanyId, {});
    expect(realRows).toHaveLength(0);
    const realStatusRows = await svc.list(realCompanyId, {
      status: "in_progress",
    });
    expect(realStatusRows).toHaveLength(0);
  });
});

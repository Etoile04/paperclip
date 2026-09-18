/**
 * NFM-4946 — ADR-014 fleet-throttle observability wiring, service level.
 *
 * AC-1: counter rows appear for the wired metrics under simulated trip
 *       conditions (simulated via the PAPERCLIP_TEST_BURN_BUDGET_OVERRIDE
 *       seam, the same seam the NFM-4695 e2e demo uses).
 * AC-2: a heavy-classified dispatch path exists and block + demote verdicts
 *       are reachable from the wakeup funnel (enqueueWakeup).
 *
 * Trip thresholds and the NFM-4658 / PR #1308 classifier contract are
 * untouched — this suite only exercises wiring that was already specified.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { persistFleetPressureState } from "../services/fleet-pressure-runtime.js";
import { HttpError } from "../errors.js";
import {
  FleetDispatchBlockedReason,
  __resetFleetThrottleMetricsForTests,
  snapshotFleetThrottleMetrics,
} from "../metrics/fleet-throttle.js";
import { TEST_BURN_BUDGET_OVERRIDE_ENV } from "../services/fleet-throttle-constants.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres fleet observability tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function setBurnOverride(pct: number | null) {
  if (pct === null) {
    delete process.env[TEST_BURN_BUDGET_OVERRIDE_ENV];
  } else {
    process.env[TEST_BURN_BUDGET_OVERRIDE_ENV] = String(pct);
  }
}

describeEmbeddedPostgres("NFM-4946 — fleet observability wiring via enqueueWakeup", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-fleet-observability-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    setBurnOverride(null);
    __resetFleetThrottleMetricsForTests();
    // Delete children before parents — heartbeat_runs FK-reference
    // agent_wakeup_requests, so the wakeup rows must go last.
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(opts: { wakeOnDemand?: boolean } = {}) {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Fleet Obs",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "FleetObsAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          // Allowed-path tests seed wakeOnDemand:false so the wake skips at
          // the policy gate (after the fleet guard, before run execution) —
          // proving the guard verdict without dragging the full adapter
          // execution stack into the fixture.
          wakeOnDemand: opts.wakeOnDemand ?? true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
  }

  it("AC-2 block — heavy wake under a simulated 25%-remaining trip is refused and counted", async () => {
    await seedAgent();
    setBurnOverride(0.25);
    __resetFleetThrottleMetricsForTests();

    await expect(
      heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        payload: { estimatedTokens: 60_000 },
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({ guardReason: "fleet_cap_tripped" }),
    } satisfies Partial<HttpError>);

    const snapshot = await snapshotFleetThrottleMetrics();
    expect(snapshot.dispatchBlocked[FleetDispatchBlockedReason.FleetCapTripped]).toBe(1);

    const [skipRow] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(skipRow?.status).toBe("skipped");
    expect(skipRow?.reason).toBe("fleet.blocked");
  });

  it("AC-2 demote — heavy continuation of a running run under a trip is demoted, not blocked", async () => {
    await seedAgent();
    const runningRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      startedAt: new Date(),
    });
    setBurnOverride(0.25);
    __resetFleetThrottleMetricsForTests();

    // Must NOT reject with the fleet 409 — the in-flight path demotes.
    await expect(
      heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        payload: { runId: runningRunId, estimatedTokens: 60_000 },
      }),
    ).resolves.not.toThrow();

    const snapshot = await snapshotFleetThrottleMetrics();
    expect(snapshot.burnDemote["read_only_review"]).toBe(1);
    expect(snapshot.dispatchBlocked[FleetDispatchBlockedReason.FleetCapTripped]).toBe(0);
  });

  it("heavy wake above budget is allowed and records no counter", async () => {
    await seedAgent({ wakeOnDemand: false });
    setBurnOverride(0.8);
    __resetFleetThrottleMetricsForTests();

    // Guard passes (heavy but under budget); the wake then skips at the
    // policy gate — no fleet 409, no counter.
    await expect(
      heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        payload: { estimatedTokens: 60_000 },
      }),
    ).resolves.not.toThrow();

    const snapshot = await snapshotFleetThrottleMetrics();
    expect(snapshot.dispatchBlocked[FleetDispatchBlockedReason.FleetCapTripped]).toBe(0);
    expect(snapshot.burnDemote["read_only_review"]).toBe(0);

    const [request] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(request?.status).toBe("skipped");
    expect(request?.reason).not.toBe("fleet.blocked");
  });

  it("estimate-less wakes keep the pre-NFM-4946 behavior (guard inert, no block)", async () => {
    await seedAgent({ wakeOnDemand: false });
    setBurnOverride(0.25);
    __resetFleetThrottleMetricsForTests();

    // No estimate → not classifiable as heavy → no fleet 409.
    await expect(
      heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        payload: { note: "no estimate supplied" },
      }),
    ).resolves.not.toThrow();

    const snapshot = await snapshotFleetThrottleMetrics();
    expect(snapshot.dispatchBlocked[FleetDispatchBlockedReason.FleetCapTripped]).toBe(0);

    const [request] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(request?.reason).not.toBe("fleet.blocked");
  });
});

describe("NFM-4946 — fleet pressure state transitions are metered", () => {
  it("AC-1 transition — persistFleetPressureState records a normal→incident transition", async () => {
    __resetFleetThrottleMetricsForTests();
    await persistFleetPressureState(
      { state: "incident", transitioned: true, limit: 25, staleClaimThresholdMs: 600_000 },
      { remainingPctOfCeiling: 0.2, tripped: true },
      { state: "normal", consecutiveNormalTicks: 0, updatedAt: new Date(0) },
    );
    const snapshot = await snapshotFleetThrottleMetrics();
    expect(snapshot.pressureTransitions["normal->incident"]).toBe(1);
    __resetFleetThrottleMetricsForTests();
  });

  it("no counter row when the tick does not transition state", async () => {
    __resetFleetThrottleMetricsForTests();
    await persistFleetPressureState(
      { state: "incident", transitioned: false, limit: 25, staleClaimThresholdMs: 600_000 },
      { remainingPctOfCeiling: 0.2, tripped: true },
      { state: "incident", consecutiveNormalTicks: 0, updatedAt: new Date(0) },
    );
    const snapshot = await snapshotFleetThrottleMetrics();
    expect(snapshot.pressureTransitions["normal->incident"]).toBe(0);
    expect(snapshot.pressureTransitions["incident->normal"]).toBe(0);
    __resetFleetThrottleMetricsForTests();
  });
});

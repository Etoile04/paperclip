/**
 * NFM-4946 — ADR-014 fleet-throttle observability wiring, counter module.
 *
 * The three metric constants defined in fleet-throttle-constants.ts
 * (agent_burn_budget_demote_total, fleet_dispatch_blocked_total,
 * fleet_pressure_state_transition_total) were previously never wired to a
 * recorder — the NFM-4716 empirical pass (addendum §6.1) had to simulate trip
 * counts from cost_events replay. These tests pin the wiring: each constant
 * must surface as a registered prom-client counter under its exact name and
 * increment through the record helpers.
 */

import { describe, expect, it } from "vitest";
import { Counter, Registry } from "prom-client";
import {
  METRIC_AGENT_BURN_DEMOTE,
  METRIC_FLEET_DISPATCH_BLOCKED,
  METRIC_FLEET_PRESSURE_TRANSITION,
} from "../services/fleet-throttle-constants.js";
import {
  FleetDispatchBlockedReason,
  __resetFleetThrottleMetricsForTests,
  createFleetThrottleMetrics,
  getFleetThrottleMetrics,
  recordAgentBurnBudgetDemote,
  recordFleetDispatchBlocked,
  recordFleetPressureStateTransition,
  renderFleetThrottleMetrics,
  snapshotFleetThrottleMetrics,
} from "./fleet-throttle.js";
import { DEMOTE_POLICY } from "../services/fleet-throttle-constants.js";

describe("NFM-4946 — fleet-throttle metric counters (recorder wiring)", () => {
  it("registers counters under the exact METRIC_* constant names", async () => {
    const metrics = createFleetThrottleMetrics();
    const rendered = await metrics.registry.metrics();
    expect(rendered).toContain(`# TYPE ${METRIC_FLEET_DISPATCH_BLOCKED} counter`);
    expect(rendered).toContain(`# TYPE ${METRIC_FLEET_PRESSURE_TRANSITION} counter`);
    expect(rendered).toContain(`# TYPE ${METRIC_AGENT_BURN_DEMOTE} counter`);
  });

  it("pre-creates zero-valued label series so scrapes surface them before the first trip", async () => {
    const metrics = createFleetThrottleMetrics();
    const snapshot = await snapshotFleetThrottleMetrics(metrics);
    expect(snapshot.dispatchBlocked[FleetDispatchBlockedReason.FleetCapTripped]).toBe(0);
    expect(snapshot.burnDemote[DEMOTE_POLICY]).toBe(0);
    expect(snapshot.pressureTransitions["normal->incident"]).toBe(0);
    expect(snapshot.pressureTransitions["incident->normal"]).toBe(0);
  });

  it("recordFleetDispatchBlocked increments the labeled series (simulated trip)", async () => {
    const metrics = createFleetThrottleMetrics();
    recordFleetDispatchBlocked(FleetDispatchBlockedReason.FleetCapTripped, metrics);
    recordFleetDispatchBlocked(FleetDispatchBlockedReason.FleetCapTripped, metrics);
    const snapshot = await snapshotFleetThrottleMetrics(metrics);
    expect(snapshot.dispatchBlocked[FleetDispatchBlockedReason.FleetCapTripped]).toBe(2);
  });

  it("recordAgentBurnBudgetDemote increments the demote counter with the policy label", async () => {
    const metrics = createFleetThrottleMetrics();
    recordAgentBurnBudgetDemote(DEMOTE_POLICY, metrics);
    const snapshot = await snapshotFleetThrottleMetrics(metrics);
    expect(snapshot.burnDemote[DEMOTE_POLICY]).toBe(1);
  });

  it("recordFleetPressureStateTransition increments both transition directions", async () => {
    const metrics = createFleetThrottleMetrics();
    recordFleetPressureStateTransition("normal", "incident", metrics);
    recordFleetPressureStateTransition("incident", "normal", metrics);
    recordFleetPressureStateTransition("normal", "incident", metrics);
    const snapshot = await snapshotFleetThrottleMetrics(metrics);
    expect(snapshot.pressureTransitions["normal->incident"]).toBe(2);
    expect(snapshot.pressureTransitions["incident->normal"]).toBe(1);
  });

  it("counters are Counter instances bound to the provided registry", () => {
    const registry = new Registry();
    const metrics = createFleetThrottleMetrics(registry);
    expect(metrics.dispatchBlocked).toBeInstanceOf(Counter);
    expect(metrics.burnDemote).toBeInstanceOf(Counter);
    expect(metrics.pressureTransition).toBeInstanceOf(Counter);
    expect(metrics.registry).toBe(registry);
  });

  it("shared bundle is stable across gets and resettable for tests", () => {
    const first = getFleetThrottleMetrics();
    expect(getFleetThrottleMetrics()).toBe(first);
    __resetFleetThrottleMetricsForTests();
    expect(getFleetThrottleMetrics()).not.toBe(first);
    __resetFleetThrottleMetricsForTests();
  });

  it("renderFleetThrottleMetrics emits Prometheus text including recorded values", async () => {
    __resetFleetThrottleMetricsForTests();
    recordFleetDispatchBlocked(FleetDispatchBlockedReason.FleetCapTripped);
    const rendered = await renderFleetThrottleMetrics();
    expect(rendered).toContain(METRIC_FLEET_DISPATCH_BLOCKED);
    expect(rendered).toMatch(new RegExp(`${METRIC_FLEET_DISPATCH_BLOCKED}\\{reason="fleet_cap_tripped"\\} 1`));
    __resetFleetThrottleMetricsForTests();
  });
});

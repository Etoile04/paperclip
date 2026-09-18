/**
 * ADR-014 fleet-throttle metric counters (NFM-4946).
 *
 * Wires the three metric constants that `fleet-throttle-constants.ts` has
 * defined since NFM-4687 but that were never recorded — the NFM-4716
 * empirical threshold pass (docs/specs/adr-014-empirical-threshold-pass.md
 * §6.1) had to *simulate* trip counts from `cost_events` replay because no
 * importer wrote these counters. The next empirical review reads real trip
 * counts from this module.
 *
 * Counters (names are the exact constant values, no extra prefix, so queries
 * can lift them straight from the spec):
 *
 * - `fleet_dispatch_blocked_total{reason}`   — L5 refused to enqueue a heavy
 *   wake (new-dispatch block path; recorded from the wakeup funnel and the
 *   heartbeat timer tick guard).
 * - `agent_burn_budget_demote_total{policy}` — L5 demoted an in-flight heavy
 *   wake to the read-only preamble (`DEMOTE_POLICY`).
 * - `fleet_pressure_state_transition_total{from,to}` — L3 fleet-pressure
 *   state machine transitioned between `normal` and `incident`.
 *
 * Pattern: mirrors `metrics/precompletion.ts` — prom-client Counters on a
 * dedicated Registry with closed label enums (bounded cardinality), shared
 * process-wide bundle, fresh-registry factory for tests, snapshot + Prometheus
 * render helpers. Label sets are pre-created at zero so a scrape before the
 * first trip still surfaces the series.
 *
 * Owners: NFM-4946 (LE) — observability wiring only; trip thresholds remain
 * the empirical values locked by NFM-4716.
 */

import { Counter, Registry } from "prom-client";
import {
  DEMOTE_POLICY,
  METRIC_AGENT_BURN_DEMOTE,
  METRIC_FLEET_DISPATCH_BLOCKED,
  METRIC_FLEET_PRESSURE_TRANSITION,
  type DemotePolicy,
} from "../services/fleet-throttle-constants.js";
import type { FleetPressureState } from "../services/fleet-pressure.js";

/**
 * Stable reason labels for `fleet_dispatch_blocked_total`.
 *
 * Closed set mirroring the block reasons emitted by
 * `fleet-dispatch-guard.evaluateDispatch`. `reason` strings here MUST match
 * the guard's `DispatchGuardResult.reason` for the block verdict; extend this
 * enum before the guard can emit any new block reason.
 */
export const FleetDispatchBlockedReason = {
  FleetCapTripped: "fleet_cap_tripped",
} as const;

export type FleetDispatchBlockedReason =
  (typeof FleetDispatchBlockedReason)[keyof typeof FleetDispatchBlockedReason];

const DISPATCH_BLOCKED_METRIC_HELP =
  "Total heavy wakeup dispatches refused by the ADR-014 L5 fleet-dispatch guard, labeled by structured block reason.";
const BURN_DEMOTE_METRIC_HELP =
  "Total in-flight heavy dispatches demoted to the read-only preamble by the ADR-014 L5 guard, labeled by demote policy.";
const PRESSURE_TRANSITION_METRIC_HELP =
  "Total ADR-014 L3 fleet-pressure state machine transitions, labeled by from/to state.";

const PRESSURE_STATES: readonly FleetPressureState[] = ["normal", "incident"];

export interface FleetThrottleMetrics {
  readonly registry: Registry;
  readonly dispatchBlocked: Counter<"reason">;
  readonly burnDemote: Counter<"policy">;
  readonly pressureTransition: Counter<"from" | "to">;
}

/**
 * Build a fresh fleet-throttle metrics bundle on a private registry. Public
 * so tests can construct isolated counters per case (same contract as
 * `createPrecompletionMetrics`).
 */
export function createFleetThrottleMetrics(registry: Registry = new Registry()): FleetThrottleMetrics {
  const dispatchBlocked = new Counter({
    name: METRIC_FLEET_DISPATCH_BLOCKED,
    help: DISPATCH_BLOCKED_METRIC_HELP,
    labelNames: ["reason"],
    registers: [registry],
  });
  const burnDemote = new Counter({
    name: METRIC_AGENT_BURN_DEMOTE,
    help: BURN_DEMOTE_METRIC_HELP,
    labelNames: ["policy"],
    registers: [registry],
  });
  const pressureTransition = new Counter({
    name: METRIC_FLEET_PRESSURE_TRANSITION,
    help: PRESSURE_TRANSITION_METRIC_HELP,
    labelNames: ["from", "to"],
    registers: [registry],
  });

  // Pre-create the label series at zero so a Prometheus scrape before the
  // first trip still surfaces the metrics with stable labels.
  for (const reason of Object.values(FleetDispatchBlockedReason)) {
    dispatchBlocked.inc({ reason }, 0);
  }
  burnDemote.inc({ policy: DEMOTE_POLICY }, 0);
  for (const from of PRESSURE_STATES) {
    for (const to of PRESSURE_STATES) {
      if (from !== to) {
        pressureTransition.inc({ from, to }, 0);
      }
    }
  }

  return { registry, dispatchBlocked, burnDemote, pressureTransition };
}

let shared: FleetThrottleMetrics | null = null;

/**
 * Lazily-constructed process-wide bundle. First call wins; later calls return
 * the same instance. Test isolation requires
 * {@link __resetFleetThrottleMetricsForTests} or a fresh
 * {@link createFleetThrottleMetrics} registry.
 */
export function getFleetThrottleMetrics(): FleetThrottleMetrics {
  if (!shared) {
    shared = createFleetThrottleMetrics();
  }
  return shared;
}

/**
 * Reset the process-wide bundle. Test-only — production code should never
 * call this.
 */
export function __resetFleetThrottleMetricsForTests(): void {
  shared = null;
}

export function recordFleetDispatchBlocked(
  reason: FleetDispatchBlockedReason,
  metrics: FleetThrottleMetrics = getFleetThrottleMetrics(),
): void {
  metrics.dispatchBlocked.inc({ reason });
}

export function recordAgentBurnBudgetDemote(
  policy: DemotePolicy = DEMOTE_POLICY,
  metrics: FleetThrottleMetrics = getFleetThrottleMetrics(),
): void {
  metrics.burnDemote.inc({ policy });
}

export function recordFleetPressureStateTransition(
  from: FleetPressureState,
  to: FleetPressureState,
  metrics: FleetThrottleMetrics = getFleetThrottleMetrics(),
): void {
  metrics.pressureTransition.inc({ from, to });
}

/** Flat snapshot for assertions. Exposed primarily for tests and diagnostics. */
export interface FleetThrottleSnapshot {
  dispatchBlocked: Record<string, number>;
  burnDemote: Record<string, number>;
  /** Keys are `"${from}->${to}"`, e.g. `"normal->incident"`. */
  pressureTransitions: Record<string, number>;
}

export async function snapshotFleetThrottleMetrics(
  metrics: FleetThrottleMetrics = getFleetThrottleMetrics(),
): Promise<FleetThrottleSnapshot> {
  const [blockedSamples, demoteSamples, transitionSamples] = await Promise.all([
    metrics.dispatchBlocked.get(),
    metrics.burnDemote.get(),
    metrics.pressureTransition.get(),
  ]);

  const blocked: Record<string, number> = {};
  for (const sample of blockedSamples.values) {
    blocked[sample.labels.reason ?? ""] = sample.value;
  }
  const demote: Record<string, number> = {};
  for (const sample of demoteSamples.values) {
    demote[sample.labels.policy ?? ""] = sample.value;
  }
  const transitions: Record<string, number> = {};
  for (const sample of transitionSamples.values) {
    const from = sample.labels.from ?? "";
    const to = sample.labels.to ?? "";
    transitions[`${from}->${to}`] = sample.value;
  }

  return { dispatchBlocked: blocked, burnDemote: demote, pressureTransitions: transitions };
}

/**
 * Render in Prometheus text exposition format. Suitable for merging into the
 * standard scrape surface alongside the precompletion metrics.
 */
export async function renderFleetThrottleMetrics(
  metrics: FleetThrottleMetrics = getFleetThrottleMetrics(),
): Promise<string> {
  return metrics.registry.metrics();
}

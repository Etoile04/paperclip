/**
 * L4 (ADR-014 §3) — per-agent token-burn budget.
 *
 * Tracks trailing AGENT_BURN_WINDOW_MS (5h) of `costEvents` per `agentId`
 * and reports `remainingPctOfCeiling` so other modules can decide whether
 * to demote in-flight heavy work or block new heavy dispatches.
 *
 * Trip semantics (CTO Locked Decision, CEO-DIRECTIVE NFM-4689):
 *   trip   when remainingPctOfCeiling <  FLEET_CAP_TRIP_REMAINING_PCT (0.30)
 *   lift   when remainingPctOfCeiling >= FLEET_CAP_LIFT_REMAINING_PCT  (0.35)
 *
 * The 5% hysteresis band prevents boundary oscillation when token spend
 * lands near the trip line.
 *
 * This module is intentionally pure (no DB). The caller injects synthetic
 * `costEvents` (already filtered to the agent's trailing window) and
 * observes the verdict. Heartbeat.ts builds the per-agent slice from the
 * existing cost-events query (`costs.ts` aggregator) and feeds it in.
 *
 * Distinct from L3 (`fleet-pressure.ts`):
 *   - L3 = fleet-wide backpressure during 1308-classified incident window
 *   - L4 = per-agent burn-vs-ceiling independent of L3 state
 */

import {
  AGENT_BURN_CEILING_CENTS_BOOTSTRAP,
  AGENT_BURN_WINDOW_MS,
  DEMOTE_POLICY,
  FLEET_CAP_LIFT_REMAINING_PCT,
  FLEET_CAP_TRIP_REMAINING_PCT,
} from "./fleet-throttle-constants.js";

export type CostEvent = {
  agentId: string;
  /** Cost in cents (USd). Matches `costEvents.costCents` schema. */
  costCents: number;
  occurredAt: Date;
};

export type AgentBudgetSnapshot = {
  agentId: string;
  windowMs: number;
  usedCents: number;
  ceilingCents: number;
  /** 1 - usedCents/ceilingCents. Clamped to [0, 1]. */
  remainingPctOfCeiling: number;
};

/**
 * Sum `costCents` for events inside the trailing window. Caller is
 * responsible for filtering to the relevant agent; this function is
 * agent-scoped to keep the test surface tight.
 */
export function sumCostInWindow(events: CostEvent[], now: Date, windowMs = AGENT_BURN_WINDOW_MS): number {
  const cutoff = now.getTime() - windowMs;
  let total = 0;
  for (const event of events) {
    if (event.occurredAt.getTime() < cutoff) continue;
    total += event.costCents;
  }
  return total;
}

/**
 * Compute the snapshot. `ceilingCents` is the per-agent cap for the 5h
 * window. The bootstrap factor (1.1x) lives in `fleet-throttle-constants.ts`
 * and MUST NOT be hand-tuned (ADR-014 §4).
 */
export function computeAgentBudgetSnapshot(input: {
  agentId: string;
  events: CostEvent[];
  now: Date;
  ceilingCents: number;
  bootstrapFactor?: number;
  windowMs?: number;
}): AgentBudgetSnapshot {
  const windowMs = input.windowMs ?? AGENT_BURN_WINDOW_MS;
  const bootstrap = input.bootstrapFactor ?? AGENT_BURN_CEILING_CENTS_BOOTSTRAP;
  const ceilingCents = input.ceilingCents * bootstrap;
  const usedCents = sumCostInWindow(input.events, input.now, windowMs);
  const remainingPctOfCeiling =
    ceilingCents <= 0 ? 1 : Math.max(0, Math.min(1, 1 - usedCents / ceilingCents));
  return {
    agentId: input.agentId,
    windowMs,
    usedCents,
    ceilingCents,
    remainingPctOfCeiling,
  };
}

/**
 * Trip predicate with hysteresis. A snapshot is `tripped` when remaining
 * is below the trip line; it only `lifts` when remaining climbs back
 * above the lift line (5% above trip).
 */
export type TripState = "tripped" | "normal";

export function evaluateTripState(snapshot: AgentBudgetSnapshot, previous: TripState): TripState {
  if (previous === "tripped") {
    return snapshot.remainingPctOfCeiling >= FLEET_CAP_LIFT_REMAINING_PCT ? "normal" : "tripped";
  }
  return snapshot.remainingPctOfCeiling < FLEET_CAP_TRIP_REMAINING_PCT ? "tripped" : "normal";
}

/**
 * Pure: read a snapshot + previous trip state, return the next trip
 * state. The caller is responsible for persisting `previous` across
 * calls; this module does not own state.
 */
export function evaluateAgentTrip(input: {
  snapshot: AgentBudgetSnapshot;
  previous: TripState;
}): { next: TripState; demotePolicy: typeof DEMOTE_POLICY | null } {
  const next = evaluateTripState(input.snapshot, input.previous);
  return {
    next,
    demotePolicy: next === "tripped" ? DEMOTE_POLICY : null,
  };
}
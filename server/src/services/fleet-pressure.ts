/**
 * L3 (ADR-014 §3) — fleet-pressure-aware tick throttle.
 *
 * Hooks:
 *   - `tickDueIssueMonitors` (heartbeat.ts:4425) — when state=incident:
 *     dispatch limit 50→25 and `staleClaimThreshold` 5min→10min.
 *   - `tickTimers` heartbeat_timer wake loop (heartbeat.ts:~12475) — when
 *     state=incident: skip wakes for agents that are NOT blocker-pinned.
 *
 * State machine:
 *   - `normal`     → enter `incident` when classifiedRunCount >=
 *     FLEET_PRESSURE_TRIP_RUN_COUNT in trailing FLEET_PRESSURE_OBSERVATION_WINDOW_MS.
 *   - `incident`   → stay in `incident` for at least
 *     FLEET_PRESSURE_INCIDENT_MIN_DWELL_MS, then lift to `normal` when
 *     classifiedRunCount < FLEET_PRESSURE_TRIP_RUN_COUNT.
 *
 * The dwell window is the hysteresis: a single 1308 spike does not
 * oscillate the throttle on/off every tick.
 *
 * This module is intentionally pure (no DB / no telemetry). The caller
 * injects the classified run count (from costEvents / heartbeatRuns) and
 * observes the verdict + per-tick parameters. Unit tests assert the
 * transition matrix deterministically.
 */

import {
  FLEET_PRESSURE_INCIDENT_MIN_DWELL_MS,
  FLEET_PRESSURE_OBSERVATION_WINDOW_MS,
  FLEET_PRESSURE_TRIP_RUN_COUNT,
  MONITOR_DISPATCH_LIMIT_INCIDENT,
  MONITOR_DISPATCH_LIMIT_NORMAL,
  STALE_CLAIM_THRESHOLD_INCIDENT_MS,
  STALE_CLAIM_THRESHOLD_NORMAL_MS,
} from "./fleet-throttle-constants.js";

export type FleetPressureStateName = "normal" | "incident";

export type FleetPressureObservation = {
  /** `claude_usage_cap_exhausted` (NFM-4658) classified runs in the trailing window. */
  classifiedRunCount: number;
  /** Current wall clock; supplied by caller for deterministic tests. */
  now: Date;
};

export type FleetPressureMemory = {
  state: FleetPressureStateName;
  /** Wall clock at which the most recent `incident` entry occurred. */
  incidentEnteredAt: Date | null;
};

export type FleetPressureTickParams = {
  /** Per-tick dispatch limit for `tickDueIssueMonitors`. */
  monitorLimit: number;
  /** `staleClaimThreshold` for `tickDueIssueMonitors`. */
  staleClaimThresholdMs: number;
  /** Whether to skip heartbeat_timer wakes for non-blocker-pinned agents. */
  skipNonBlockerPinnedHeartbeats: boolean;
};

export const FLEET_PRESSURE_DEFAULT_MEMORY: FleetPressureMemory = {
  state: "normal",
  incidentEnteredAt: null,
};

/**
 * Pure transition. Given current memory + observation, return the next
 * memory + the per-tick parameters the caller should apply.
 *
 * The transition matrix (unit-tested):
 *   (normal,    count>=1)                → incident  (start dwell timer)
 *   (normal,    count< 1)                → normal    (no-op)
 *   (incident,  within dwell)            → incident  (hysteresis hold)
 *   (incident,  past dwell, count>=1)    → incident  (refresh)
 *   (incident,  past dwell, count< 1)    → normal    (lift)
 */
export function evaluateFleetPressure(
  memory: FleetPressureMemory,
  observation: FleetPressureObservation,
): { memory: FleetPressureMemory; params: FleetPressureTickParams } {
  const tripped = observation.classifiedRunCount >= FLEET_PRESSURE_TRIP_RUN_COUNT;
  const dwellExpired =
    memory.state === "incident" &&
    memory.incidentEnteredAt !== null &&
    observation.now.getTime() - memory.incidentEnteredAt.getTime() >=
      FLEET_PRESSURE_INCIDENT_MIN_DWELL_MS;

  let nextState: FleetPressureStateName = memory.state;
  let nextIncidentEnteredAt = memory.incidentEnteredAt;

  if (memory.state === "normal" && tripped) {
    nextState = "incident";
    nextIncidentEnteredAt = observation.now;
  } else if (memory.state === "incident") {
    if (!dwellExpired) {
      // Hysteresis hold — stay in incident regardless of count.
      nextState = "incident";
    } else if (tripped) {
      // Past dwell but still tripped — refresh dwell anchor.
      nextState = "incident";
      nextIncidentEnteredAt = observation.now;
    } else {
      // Past dwell and count dropped — lift.
      nextState = "normal";
      nextIncidentEnteredAt = null;
    }
  }

  const params: FleetPressureTickParams =
    nextState === "incident"
      ? {
          monitorLimit: MONITOR_DISPATCH_LIMIT_INCIDENT,
          staleClaimThresholdMs: STALE_CLAIM_THRESHOLD_INCIDENT_MS,
          skipNonBlockerPinnedHeartbeats: true,
        }
      : {
          monitorLimit: MONITOR_DISPATCH_LIMIT_NORMAL,
          staleClaimThresholdMs: STALE_CLAIM_THRESHOLD_NORMAL_MS,
          skipNonBlockerPinnedHeartbeats: false,
        };

  return {
    memory: {
      state: nextState,
      incidentEnteredAt: nextIncidentEnteredAt,
    },
    params,
  };
}

/**
 * Convenience: an agent is "blocker-pinned" when at least one of its
 * currently assigned issues carries a non-empty `blockedByIssueIds` (i.e.,
 * the wake is required to unblock another issue's continuation path).
 *
 * The actual SQL lives in the heartbeat.ts hook; this helper exists for
 * pure-function unit testing of the predicate on synthetic issue rows.
 */
export function isAgentBlockerPinned(
  issues: Array<{ status: string; blockedByIssueIds: unknown }>,
): boolean {
  for (const issue of issues) {
    if (issue.status !== "in_progress" && issue.status !== "in_review") continue;
    if (Array.isArray(issue.blockedByIssueIds) && issue.blockedByIssueIds.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Trailing window length (ms) for classifiedRunCount observation. Exported
 * so heartbeat.ts can compute the count over the correct slice without
 * re-importing the constants module.
 */
export const FLEET_PRESSURE_WINDOW_MS = FLEET_PRESSURE_OBSERVATION_WINDOW_MS;
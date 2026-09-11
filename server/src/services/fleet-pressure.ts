/**
 * ADR-014 L3 — fleet-pressure-aware tick throttle.
 *
 * When the fleet-wide 5h usage cap is under pressure, halve the monitor
 * dispatch limit and double the stale-claim threshold so the fleet does
 * not synchronously hammer the broker on the cap-reset boundary. Hysteresis
 * (FLEET_PRESSURE_HYSTERESIS_TICKS consecutive normal readings) prevents
 * flapping between states under bursty load.
 *
 * Owners: NFM-4687 (LE, implement) — see ADR-014 §3 L3.
 */

import {
  FLEET_PRESSURE_HYSTERESIS_TICKS,
  FLEET_PRESSURE_LIMIT_INCIDENT,
  FLEET_PRESSURE_LIMIT_NORMAL,
  FLEET_PRESSURE_STALE_INCIDENT_MS,
  FLEET_PRESSURE_STALE_NORMAL_MS,
} from "./fleet-throttle-constants.js";

export type FleetPressureState = "normal" | "incident";

export interface FleetPressureReading {
  /** Observed remaining fraction of fleet 5h cap. */
  remainingPctOfCeiling: number;
  /** State machine input — read from costEvents aggregate over 5h window. */
  tripped: boolean;
}

export interface FleetPressureDecision {
  state: FleetPressureState;
  /** Effective per-tick monitor dispatch limit. */
  limit: number;
  /** Effective staleClaimThreshold (ms). */
  staleClaimThresholdMs: number;
  /** True if the state transitioned this tick. */
  transitioned: boolean;
}

/**
 * Pure state-machine function. Used by tests and by the heartbeat tick.
 * Caller is responsible for tracking `consecutiveNormalTicks` across calls.
 */
export function decideFleetPressure(
  reading: FleetPressureReading,
  prevState: FleetPressureState,
  consecutiveNormalTicks: number,
): FleetPressureDecision {
  if (reading.tripped) {
    return {
      state: "incident",
      limit: FLEET_PRESSURE_LIMIT_INCIDENT,
      staleClaimThresholdMs: FLEET_PRESSURE_STALE_INCIDENT_MS,
      transitioned: prevState !== "incident",
    };
  }
  // Reading is normal. Stay in incident only until hysteresis clears.
  if (prevState === "incident") {
    if (consecutiveNormalTicks + 1 >= FLEET_PRESSURE_HYSTERESIS_TICKS) {
      return {
        state: "normal",
        limit: FLEET_PRESSURE_LIMIT_NORMAL,
        staleClaimThresholdMs: FLEET_PRESSURE_STALE_NORMAL_MS,
        transitioned: true,
      };
    }
    return {
      state: "incident",
      limit: FLEET_PRESSURE_LIMIT_INCIDENT,
      staleClaimThresholdMs: FLEET_PRESSURE_STALE_INCIDENT_MS,
      transitioned: false,
    };
  }
  return {
    state: "normal",
    limit: FLEET_PRESSURE_LIMIT_NORMAL,
    staleClaimThresholdMs: FLEET_PRESSURE_STALE_NORMAL_MS,
    transitioned: false,
  };
}

import { describe, expect, it } from "vitest";
import {
  decideFleetPressure,
  type FleetPressureReading,
} from "./fleet-pressure.js";
import {
  FLEET_PRESSURE_HYSTERESIS_TICKS,
  FLEET_PRESSURE_LIMIT_INCIDENT,
  FLEET_PRESSURE_LIMIT_NORMAL,
  FLEET_PRESSURE_STALE_INCIDENT_MS,
  FLEET_PRESSURE_STALE_NORMAL_MS,
} from "./fleet-throttle-constants.js";

describe("L3 — fleet-pressure state machine", () => {
  it("stays normal when reading is not tripped", () => {
    const reading: FleetPressureReading = { remainingPctOfCeiling: 0.6, tripped: false };
    const d = decideFleetPressure(reading, "normal", 0);
    expect(d.state).toBe("normal");
    expect(d.limit).toBe(FLEET_PRESSURE_LIMIT_NORMAL);
    expect(d.staleClaimThresholdMs).toBe(FLEET_PRESSURE_STALE_NORMAL_MS);
    expect(d.transitioned).toBe(false);
  });

  it("enters incident immediately on a tripped reading", () => {
    const reading: FleetPressureReading = { remainingPctOfCeiling: 0.2, tripped: true };
    const d = decideFleetPressure(reading, "normal", 0);
    expect(d.state).toBe("incident");
    expect(d.limit).toBe(FLEET_PRESSURE_LIMIT_INCIDENT);
    expect(d.staleClaimThresholdMs).toBe(FLEET_PRESSURE_STALE_INCIDENT_MS);
    expect(d.transitioned).toBe(true);
  });

  it("holds incident through hysteresis and transitions to normal only after enough normal readings", () => {
    const normalReading: FleetPressureReading = { remainingPctOfCeiling: 0.8, tripped: false };

    // Just exited incident: 1st normal reading — still incident.
    const d1 = decideFleetPressure(normalReading, "incident", 0);
    expect(d1.state).toBe("incident");
    expect(d1.transitioned).toBe(false);

    // 2nd normal — still incident.
    const d2 = decideFleetPressure(normalReading, "incident", 1);
    expect(d2.state).toBe("incident");
    expect(d2.transitioned).toBe(false);

    // 3rd normal — hysteresis threshold reached → transition to normal.
    const d3 = decideFleetPressure(normalReading, "incident", 2);
    expect(d3.state).toBe("normal");
    expect(d3.transitioned).toBe(true);
    expect(d3.limit).toBe(FLEET_PRESSURE_LIMIT_NORMAL);
  });

  it("re-enters incident immediately if a tripped reading arrives mid-hysteresis", () => {
    const tripped: FleetPressureReading = { remainingPctOfCeiling: 0.2, tripped: true };
    const d = decideFleetPressure(tripped, "incident", 1);
    expect(d.state).toBe("incident");
    expect(d.transitioned).toBe(false); // already in incident
  });

  it("emits no transition on repeated normal readings", () => {
    const normalReading: FleetPressureReading = { remainingPctOfCeiling: 0.9, tripped: false };
    const d = decideFleetPressure(normalReading, "normal", 99);
    expect(d.transitioned).toBe(false);
  });

  it("hysteresis constant matches the documented value", () => {
    expect(FLEET_PRESSURE_HYSTERESIS_TICKS).toBe(3);
  });
});

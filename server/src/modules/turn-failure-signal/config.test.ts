import { describe, expect, it } from "vitest";
import { TURN_FAILURE_SIGNAL_DEFAULTS, resolveTurnFailureSignalConfig } from "./config.js";

describe("resolveTurnFailureSignalConfig", () => {
  it("disables the signal when no canary state path is configured", () => {
    const config = resolveTurnFailureSignalConfig({});
    expect(config.enabled).toBe(false);
    expect(config.canaryStatePath).toBeNull();
  });

  it("enables the signal when a canary state path is set", () => {
    const config = resolveTurnFailureSignalConfig({
      TURN_FAILURE_SIGNAL_CANARY_STATE_PATH: "/state/provider_canary_state.json",
    });
    expect(config.enabled).toBe(true);
    expect(config.canaryStatePath).toBe("/state/provider_canary_state.json");
    expect(config.windowMs).toBe(TURN_FAILURE_SIGNAL_DEFAULTS.windowMs);
    expect(config.elevationThreshold).toBe(TURN_FAILURE_SIGNAL_DEFAULTS.elevationThreshold);
  });

  it("keeps recovery strictly below elevation (hysteresis invariant)", () => {
    const config = resolveTurnFailureSignalConfig({
      TURN_FAILURE_SIGNAL_ELEVATION_THRESHOLD: "0.4",
      TURN_FAILURE_SIGNAL_RECOVERY_THRESHOLD: "0.9",
    });
    expect(config.recoveryThreshold).toBeLessThanOrEqual(config.elevationThreshold / 2);
  });

  it("clamps rates into [0,1]", () => {
    const config = resolveTurnFailureSignalConfig({
      TURN_FAILURE_SIGNAL_ELEVATION_THRESHOLD: "7",
      TURN_FAILURE_SIGNAL_RECOVERY_THRESHOLD: "-2",
    });
    expect(config.elevationThreshold).toBe(1);
    expect(config.recoveryThreshold).toBe(0);
  });

  it("falls back to defaults on non-numeric input", () => {
    const config = resolveTurnFailureSignalConfig({
      TURN_FAILURE_SIGNAL_WINDOW_MS: "soon",
      TURN_FAILURE_SIGNAL_MIN_SAMPLES: "lots",
    });
    expect(config.windowMs).toBe(TURN_FAILURE_SIGNAL_DEFAULTS.windowMs);
    expect(config.minSamples).toBe(TURN_FAILURE_SIGNAL_DEFAULTS.minSamples);
  });

  it("floors the window and sample knobs to safe minimums", () => {
    const config = resolveTurnFailureSignalConfig({
      TURN_FAILURE_SIGNAL_WINDOW_MS: "100",
      TURN_FAILURE_SIGNAL_MIN_SAMPLES: "0",
      TURN_FAILURE_SIGNAL_RESTATE_INTERVAL_MS: "1",
      TURN_FAILURE_SIGNAL_CANARY_MAX_AGE_MS: "0",
    });
    expect(config.windowMs).toBe(60_000);
    expect(config.minSamples).toBe(1);
    expect(config.restateIntervalMs).toBe(60_000);
    expect(config.canaryMaxAgeMs).toBe(60_000);
  });
});

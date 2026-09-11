import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFleetCapFixture,
  getActiveFleetCapFixture,
  isFleetCapSeamActive,
  loadFleetCapFixture,
  resolveFleetCapReading,
} from "./fleet-cap-test-seam.js";

describe("fleet-cap test seam — activation gating", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    clearFleetCapFixture();
  });

  afterEach(() => {
    process.env = originalEnv;
    clearFleetCapFixture();
  });

  it("is inactive by default (no env flag set)", () => {
    delete process.env.PAPERCLIP_FLEET_CAP_TEST_SEAM;
    expect(isFleetCapSeamActive()).toBe(false);
  });

  it("is inactive when env flag set to anything other than '1'", () => {
    process.env.PAPERCLIP_FLEET_CAP_TEST_SEAM = "true";
    expect(isFleetCapSeamActive()).toBe(false);
    process.env.PAPERCLIP_FLEET_CAP_TEST_SEAM = "0";
    expect(isFleetCapSeamActive()).toBe(false);
    process.env.PAPERCLIP_FLEET_CAP_TEST_SEAM = "";
    expect(isFleetCapSeamActive()).toBe(false);
  });

  it("is active when env flag is exactly '1'", () => {
    process.env.PAPERCLIP_FLEET_CAP_TEST_SEAM = "1";
    expect(isFleetCapSeamActive()).toBe(true);
  });

  it("loadFleetCapFixture throws when seam inactive", () => {
    expect(isFleetCapSeamActive()).toBe(false);
    expect(() =>
      loadFleetCapFixture({ remainingByAgent: { "agent-x": 0.25 } }),
    ).toThrow(/seam is not active/);
  });

  it("loadFleetCapFixture succeeds when seam active and resolves for the agent", () => {
    process.env.PAPERCLIP_FLEET_CAP_TEST_SEAM = "1";
    loadFleetCapFixture({ remainingByAgent: { "agent-1": 0.25 } });
    const fixture = getActiveFleetCapFixture();
    expect(fixture).not.toBeNull();
    const reading = resolveFleetCapReading("agent-1", { consumedTokens: 0, ceilingTokens: 1_100_000 });
    expect(reading).not.toBeNull();
    expect(reading?.remainingPctOfCeiling).toBe(0.25);
    expect(reading?.source).toBe("synthetic_fixture");
  });

  it("fleet-wide override applies when per-agent entry absent", () => {
    process.env.PAPERCLIP_FLEET_CAP_TEST_SEAM = "1";
    loadFleetCapFixture({ fleetRemainingPct: 0.5 });
    const reading = resolveFleetCapReading("agent-unknown", { consumedTokens: 0, ceilingTokens: 1_100_000 });
    expect(reading?.remainingPctOfCeiling).toBe(0.5);
  });

  it("returns null when fixture loaded but neither per-agent nor fleet override matches", () => {
    process.env.PAPERCLIP_FLEET_CAP_TEST_SEAM = "1";
    loadFleetCapFixture({ remainingByAgent: { "agent-1": 0.25 } });
    const reading = resolveFleetCapReading("agent-2", { consumedTokens: 0, ceilingTokens: 1_100_000 });
    expect(reading).toBeNull();
  });
});
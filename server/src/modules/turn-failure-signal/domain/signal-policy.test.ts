import { describe, expect, it } from "vitest";
import {
  decideDegradationHold,
  decideDegradationOpen,
  shouldRestateDegradation,
  turnFailureRate,
  type CanaryObservation,
  type TurnFailureSignalConfig,
  type TurnFailureWindowStats,
} from "./signal-policy.js";

const T0 = "2026-10-26T12:00:00.000Z";

const BASE_CONFIG: TurnFailureSignalConfig = {
  windowMs: 15 * 60 * 1000,
  elevationThreshold: 0.5,
  recoveryThreshold: 0.25,
  minSamples: 10,
  restateIntervalMs: 60 * 60 * 1000,
};

function stats(overrides: Partial<TurnFailureWindowStats> = {}): TurnFailureWindowStats {
  return {
    outcomes: 20,
    authFailures: 0,
    otherFailures: 0,
    windowStart: "2026-10-26T11:45:00.000Z",
    windowEnd: T0,
    ...overrides,
  };
}

function canary(state: CanaryObservation["state"]): CanaryObservation {
  return { state, observedAt: state === "unknown" ? null : T0 };
}

describe("turnFailureRate", () => {
  it("combines auth and non-auth failures over attributable outcomes", () => {
    expect(
      turnFailureRate(stats({ outcomes: 20, authFailures: 3, otherFailures: 2 })),
    ).toBeCloseTo(0.25);
  });

  it("is zero for an empty window", () => {
    expect(turnFailureRate(stats({ outcomes: 0 }))).toBe(0);
  });
});

describe("decideDegradationOpen — full signature only", () => {
  it("opens when canary green AND rate elevated AND samples trusted", () => {
    const decision = decideDegradationOpen({
      stats: stats({ authFailures: 6, otherFailures: 5 }),
      canary: canary("green"),
      config: BASE_CONFIG,
    });
    expect(decision).toEqual({ action: "open" });
  });

  // Charter AC: verified NO alarm during normal canary-green operation.
  it("does NOT alarm during normal canary-green operation (negative test)", () => {
    const decision = decideDegradationOpen({
      stats: stats({ authFailures: 1, otherFailures: 0 }),
      canary: canary("green"),
      config: BASE_CONFIG,
    });
    expect(decision).toEqual({ action: "noop", reason: "rate-normal" });
  });

  it("never alarms while the canary is red — the liveness authority owns that page", () => {
    const decision = decideDegradationOpen({
      stats: stats({ authFailures: 10, otherFailures: 5 }),
      canary: canary("red"),
      config: BASE_CONFIG,
    });
    expect(decision).toEqual({ action: "noop", reason: "canary-not-green" });
  });

  it("never alarms on an unknown/stale canary — green is never assumed", () => {
    const decision = decideDegradationOpen({
      stats: stats({ authFailures: 10, otherFailures: 5 }),
      canary: canary("unknown"),
      config: BASE_CONFIG,
    });
    expect(decision).toEqual({ action: "noop", reason: "canary-not-green" });
  });

  it("refuses to trust the rate below the sample floor (one flake cannot trip it)", () => {
    const decision = decideDegradationOpen({
      stats: stats({ outcomes: 1, otherFailures: 1 }),
      canary: canary("green"),
      config: BASE_CONFIG,
    });
    expect(decision).toEqual({ action: "noop", reason: "insufficient-samples" });
  });
});

describe("decideDegradationHold", () => {
  const episode = { id: "ep-1", state: "red" as const, startedAt: T0, lastRestatedAt: null };

  it("closes on normalized rate once samples are trusted again", () => {
    const decision = decideDegradationHold({
      stats: stats({ authFailures: 1, otherFailures: 1 }),
      canary: canary("green"),
      episode,
      now: T0,
      config: BASE_CONFIG,
    });
    expect(decision).toEqual({ action: "close", source: "normalized" });
  });

  it("hands off to the auth machinery when the canary goes red", () => {
    const decision = decideDegradationHold({
      stats: stats({ authFailures: 12, otherFailures: 4 }),
      canary: canary("red"),
      episode,
      now: T0,
      config: BASE_CONFIG,
    });
    expect(decision).toEqual({ action: "close", source: "canary-red" });
  });

  it("holds without restating while the canary is unreadable", () => {
    const decision = decideDegradationHold({
      stats: stats({ authFailures: 12, otherFailures: 4 }),
      canary: canary("unknown"),
      episode,
      now: T0,
      config: BASE_CONFIG,
    });
    expect(decision).toEqual({ action: "hold" });
  });

  it("restates at most once per interval while red on a green canary", () => {
    const decision = decideDegradationHold({
      stats: stats({ authFailures: 12, otherFailures: 4 }),
      canary: canary("green"),
      episode,
      now: "2026-10-26T12:30:00.000Z",
      config: BASE_CONFIG,
    });
    expect(decision).toEqual({ action: "hold" });
  });

  it("restates after the interval elapses on a still-elevated green-canary window", () => {
    const decision = decideDegradationHold({
      stats: stats({ authFailures: 12, otherFailures: 4 }),
      canary: canary("green"),
      episode,
      now: "2026-10-26T13:00:00.000Z",
      config: BASE_CONFIG,
    });
    expect(decision).toEqual({ action: "restate" });
  });

  it("does not close on a normalizing rate while samples are too thin", () => {
    const decision = decideDegradationHold({
      stats: stats({ outcomes: 2, authFailures: 1 }),
      canary: canary("green"),
      episode,
      now: T0,
      config: BASE_CONFIG,
    });
    expect(decision).toEqual({ action: "hold" });
  });
});

describe("shouldRestateDegradation", () => {
  it("measures the first restate from the episode open", () => {
    expect(
      shouldRestateDegradation({
        lastRestatedAt: null,
        episodeStartedAt: T0,
        now: "2026-10-26T12:59:59.000Z",
        restateIntervalMs: 60 * 60 * 1000,
      }),
    ).toBe(false);
    expect(
      shouldRestateDegradation({
        lastRestatedAt: null,
        episodeStartedAt: T0,
        now: "2026-10-26T13:00:00.000Z",
        restateIntervalMs: 60 * 60 * 1000,
      }),
    ).toBe(true);
  });

  it("measures subsequent restates from the last one", () => {
    expect(
      shouldRestateDegradation({
        lastRestatedAt: "2026-10-26T13:00:00.000Z",
        episodeStartedAt: T0,
        now: "2026-10-26T13:59:59.000Z",
        restateIntervalMs: 60 * 60 * 1000,
      }),
    ).toBe(false);
    expect(
      shouldRestateDegradation({
        lastRestatedAt: "2026-10-26T13:00:00.000Z",
        episodeStartedAt: T0,
        now: "2026-10-26T14:00:00.000Z",
        restateIntervalMs: 60 * 60 * 1000,
      }),
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { STRANDED_ARM_RATE_LIMIT_MS, decideStrandedArmRateLimit } from "./service.js";

const HOUR_MS = 60 * 60 * 1000;
const now = new Date("2026-09-19T12:00:00.000Z");

describe("decideStrandedArmRateLimit (NFM-4958 3)", () => {
  it("exports a 6h rate-limit window", () => {
    expect(STRANDED_ARM_RATE_LIMIT_MS).toBe(6 * HOUR_MS);
  });

  it("proceeds when no prior arm attempt exists", () => {
    expect(decideStrandedArmRateLimit({ now, lastAttemptAt: null, hasNewEvidence: false })).toEqual({
      kind: "proceed",
    });
  });

  it("skips a second arm inside the window when no new evidence exists", () => {
    expect(decideStrandedArmRateLimit({
      now,
      lastAttemptAt: new Date(now.getTime() - HOUR_MS),
      hasNewEvidence: false,
    })).toEqual({
      kind: "skip",
      reason: "recent arm attempt inside rate-limit window without new evidence",
    });
  });

  it("proceeds inside the window when new evidence exists (failed run, status transition, or explicit escalation)", () => {
    expect(decideStrandedArmRateLimit({
      now,
      lastAttemptAt: new Date(now.getTime() - HOUR_MS),
      hasNewEvidence: true,
    })).toEqual({ kind: "proceed" });
  });

  it("proceeds once the window has elapsed, even without new evidence", () => {
    expect(decideStrandedArmRateLimit({
      now,
      lastAttemptAt: new Date(now.getTime() - 6 * HOUR_MS),
      hasNewEvidence: false,
    })).toEqual({ kind: "proceed" });
  });
});

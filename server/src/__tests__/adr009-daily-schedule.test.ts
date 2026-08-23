/**
 * ADR-009 §4.3 (NFM-3584): Schedule helper unit tests.
 *
 * Verifies that the in-code cron expression `0 6 * * *` UTC correctly
 * identifies the 06:00 UTC minute and is idempotent within a process.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  ADR009_DAILY_RECONCILE_CRON,
  __resetAdr009DailyReconcileStateForTests,
  shouldFireAdr009DailyReconcile,
} from "../services/adr009-daily-schedule.js";

afterEach(() => {
  __resetAdr009DailyReconcileStateForTests();
});

describe("adr009-daily-schedule", () => {
  it("exports the canonical 0 6 * * * UTC cron", () => {
    expect(ADR009_DAILY_RECONCILE_CRON).toBe("0 6 * * *");
  });

  it("fires when the wall clock is exactly 06:00 UTC", () => {
    const sixAmUtc = new Date(Date.UTC(2026, 7, 24, 6, 0, 0));
    expect(shouldFireAdr009DailyReconcile(sixAmUtc)).toBe(true);
  });

  it("does not fire at any other minute", () => {
    const otherMinute = new Date(Date.UTC(2026, 7, 24, 6, 1, 0));
    expect(shouldFireAdr009DailyReconcile(otherMinute)).toBe(false);

    const fiveFiftyNineUtc = new Date(Date.UTC(2026, 7, 24, 5, 59, 30));
    expect(shouldFireAdr009DailyReconcile(fiveFiftyNineUtc)).toBe(false);

    const sixOhOneUtc = new Date(Date.UTC(2026, 7, 24, 6, 1, 0));
    expect(shouldFireAdr009DailyReconcile(sixOhOneUtc)).toBe(false);
  });

  it("is idempotent within the same fire-minute across repeated calls", () => {
    const sixAm = new Date(Date.UTC(2026, 7, 24, 6, 0, 0));
    expect(shouldFireAdr009DailyReconcile(sixAm)).toBe(true);
    // Second call in the same minute must be a no-op.
    expect(shouldFireAdr009DailyReconcile(sixAm)).toBe(false);
    expect(shouldFireAdr009DailyReconcile(sixAm)).toBe(false);
  });

  it("fires again the next day at 06:00 UTC", () => {
    const dayOne = new Date(Date.UTC(2026, 7, 24, 6, 0, 0));
    expect(shouldFireAdr009DailyReconcile(dayOne)).toBe(true);
    const dayTwo = new Date(Date.UTC(2026, 7, 25, 6, 0, 0));
    expect(shouldFireAdr009DailyReconcile(dayTwo)).toBe(true);
  });
});
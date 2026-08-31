/**
 * ADR-010 §D2 (NFM-3860): Schedule helper unit tests.
 *
 * Mirrors the §4.3-a daily-schedule test (NFM-3584) so the new D2 cron
 * expression `0 5 * * *` UTC has the same idempotent, in-process-safe
 * semantics. The D2 tick fires one hour BEFORE §4.3-a so any backfill
 * recovery children created by D2 are visible to the §4.3-a prune
 * sweep that follows.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  ADR010_DAILY_PHANTOM_BACKFILL_CRON,
  __resetAdr010DailyPhantomBackfillStateForTests,
  shouldFireAdr010DailyPhantomBackfill,
} from "../services/adr010-phantom-backfill-schedule.js";

afterEach(() => {
  __resetAdr010DailyPhantomBackfillStateForTests();
});

describe("adr010-phantom-backfill-schedule", () => {
  it("exports the canonical 0 5 * * * UTC cron", () => {
    expect(ADR010_DAILY_PHANTOM_BACKFILL_CRON).toBe("0 5 * * *");
  });

  it("fires when the wall clock is exactly 05:00 UTC", () => {
    const fiveAmUtc = new Date(Date.UTC(2026, 7, 24, 5, 0, 0));
    expect(shouldFireAdr010DailyPhantomBackfill(fiveAmUtc)).toBe(true);
  });

  it("does not fire at any other minute", () => {
    const otherMinute = new Date(Date.UTC(2026, 7, 24, 5, 1, 0));
    expect(shouldFireAdr010DailyPhantomBackfill(otherMinute)).toBe(false);

    const sixAmUtc = new Date(Date.UTC(2026, 7, 24, 6, 0, 0));
    expect(shouldFireAdr010DailyPhantomBackfill(sixAmUtc)).toBe(false);

    const fourAmUtc = new Date(Date.UTC(2026, 7, 24, 4, 59, 0));
    expect(shouldFireAdr010DailyPhantomBackfill(fourAmUtc)).toBe(false);
  });

  it("is idempotent within a process: a second call in the same minute returns false", () => {
    const fiveAmUtc = new Date(Date.UTC(2026, 7, 24, 5, 0, 0));
    expect(shouldFireAdr010DailyPhantomBackfill(fiveAmUtc)).toBe(true);
    expect(shouldFireAdr010DailyPhantomBackfill(fiveAmUtc)).toBe(false);
  });

  it("a fresh process resets the fire memoization", () => {
    const fiveAmUtc = new Date(Date.UTC(2026, 7, 24, 5, 0, 0));
    expect(shouldFireAdr010DailyPhantomBackfill(fiveAmUtc)).toBe(true);
    __resetAdr010DailyPhantomBackfillStateForTests();
    expect(shouldFireAdr010DailyPhantomBackfill(fiveAmUtc)).toBe(true);
  });
});
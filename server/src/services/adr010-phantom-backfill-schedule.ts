/**
 * ADR-010 §D2 (NFM-3860): Schedule helpers for the daily 05:00 UTC
 * phantom-merge-pass backfill routine.
 *
 * Expresses the schedule in code (mirroring §4.3-a, NFM-3584). The
 * schedule is a standard 5-field cron expression evaluated against UTC.
 * The downstream ticker in `server/src/index.ts` polls every minute and
 * fires when the current minute matches the next computed tick.
 *
 * The companion backfill routine — `phantomBackfill.reconcilePhantomMergePasses` —
 * is feature-flag-gated and is idempotent, so any extra fires within the
 * same window are safe no-ops.
 *
 * Why 05:00 UTC and not 06:00 (the §4.3-a tick)?
 * -------------------------------------------------
 * §D2 emits recovery children for phantom merge passes. §4.3-a then walks
 * every dependent's `blockedByIssueIds` and prunes any UUID whose referenced
 * issue is `done` or `cancelled`. We want §D2's recovery children to be
 * visible to §4.3-a's next prune sweep, so §D2 fires one hour EARLIER in
 * the day. Same-company scope means both ticks operate on the same DB, so
 * the ordering is deterministic across restarts.
 */

import { parseCron, validateCron } from "./cron.js";

export const ADR010_DAILY_PHANTOM_BACKFILL_CRON = "0 5 * * *" as const;
export const ADR010_DAILY_PHANTOM_BACKFILL_TZ = "UTC" as const;

// Validate the constant at module load — fail fast on a bad expression.
validateCron(ADR010_DAILY_PHANTOM_BACKFILL_CRON);

let lastFireKey: string | null = null;

/**
 * Returns `true` if `now` falls inside the minute that matches the
 * 05:00 UTC tick (and we haven't already fired for that minute in this
 * process lifetime). Use this from a per-minute `setInterval` to drive the
 * daily backfill routine.
 *
 * Idempotent within a process: once a particular fire-key has been
 * returned, subsequent calls within the same minute return `false` even
 * across multiple ticks. A fresh process resets the key (intentional —
 * restarts should not skip a scheduled tick).
 */
export function shouldFireAdr010DailyPhantomBackfill(now: Date = new Date()): boolean {
  const cron = parseCron(ADR010_DAILY_PHANTOM_BACKFILL_CRON);

  const minute = now.getUTCMinutes();
  const hour = now.getUTCHours();
  const dayOfMonth = now.getUTCDate();
  const month = now.getUTCMonth() + 1; // 1-12
  const dayOfWeek = now.getUTCDay(); // 0-6

  if (
    !cron.minutes.includes(minute) ||
    !cron.hours.includes(hour) ||
    !cron.daysOfMonth.includes(dayOfMonth) ||
    !cron.months.includes(month) ||
    !cron.daysOfWeek.includes(dayOfWeek)
  ) {
    return false;
  }

  // Compute a stable fire key (year-month-day-hour-minute UTC) so two ticks
  // in the same minute can never both return `true`.
  const fireKey = `${now.getUTCFullYear()}-${month}-${dayOfMonth}-${hour}-${minute}`;
  if (lastFireKey === fireKey) return false;
  lastFireKey = fireKey;
  return true;
}

/** Test-only: forget the last-fire memoization between test cases. */
export function __resetAdr010DailyPhantomBackfillStateForTests(): void {
  lastFireKey = null;
}
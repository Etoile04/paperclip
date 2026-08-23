/**
 * ADR-009 §4.3 (NFM-3584): Schedule helpers for the daily 06:00 UTC
 * reconciliation routine.
 *
 * Expresses the schedule in code (per Sibling A AC: "Schedule must live in
 * code, not in a manual operator action"). The schedule is a standard
 * 5-field cron expression evaluated against UTC. The downstream ticker in
 * `server/src/index.ts` polls every minute and fires when the current
 * minute matches the next computed tick.
 *
 * The companion recovery routine — `recoveryService.reconcileBlockedByIssueIds` —
 * is feature-flag-gated and is idempotent, so any extra fires within the
 * same window are safe no-ops.
 */

import { parseCron, validateCron } from "./cron.js";

export const ADR009_DAILY_RECONCILE_CRON = "0 6 * * *" as const;
export const ADR009_DAILY_RECONCILE_TZ = "UTC" as const;

// Validate the constant at module load — fail fast on a bad expression.
validateCron(ADR009_DAILY_RECONCILE_CRON);

let lastFireKey: string | null = null;

/**
 * Returns `true` if `now` falls inside the minute that matches the
 * 06:00 UTC tick (and we haven't already fired for that minute in this
 * process lifetime). Use this from a per-minute `setInterval` to drive the
 * daily reconciliation routine.
 *
 * Idempotent within a process: once a particular fire-key has been
 * returned, subsequent calls within the same minute return `false` even
 * across multiple ticks. A fresh process resets the key (intentional —
 * restarts should not skip a scheduled tick).
 */
export function shouldFireAdr009DailyReconcile(now: Date = new Date()): boolean {
  const cron = parseCron(ADR009_DAILY_RECONCILE_CRON);

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
export function __resetAdr009DailyReconcileStateForTests(): void {
  lastFireKey = null;
}
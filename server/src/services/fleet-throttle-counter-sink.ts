/**
 * NFM-4946 — persistence sink for ADR-014 fleet-throttle metric counters.
 *
 * `metrics/fleet-throttle.ts` keeps the prom-client counters as the
 * in-process scrape surface; this module drains recorded trips into the
 * `tool_runtime_metric_counters` table so the next ADR-014 empirical review
 * reads real trip counts from the database instead of replaying
 * `cost_events` (the NFM-4716 §6.1 pass simulated counts because the table
 * had no writer).
 *
 * Semantics:
 * - Trips accumulate in an in-memory pending map keyed by
 *   (companyId | fleet-global, metric row key, hourly bucket). `flush`
 *   drains the map and upserts additively —
 *   `ON CONFLICT (company_id, metric, bucket_start_at) DO UPDATE SET
 *   count = ... + EXCLUDED.count` — so repeated flushes are idempotent in
 *   the additive sense and safe across concurrent server processes.
 * - The `metric` column renders name + labels in Prometheus exposition
 *   syntax (`fleet_dispatch_blocked_total{reason="fleet_cap_tripped"}`),
 *   keeping labeled series distinct and directly queryable.
 * - Fleet-global trips (L3 pressure transitions — process-wide state by
 *   design, ADR-014 §3) are replicated once per company passed to
 *   `flushFleetThrottleCounters`, because the table requires a real
 *   company_id (NOT NULL + FK) while L3 has no per-company attribution.
 *
 * Failure isolation: callers wrap flushes in try/catch — a telemetry sink
 * failure must never alter guard verdicts or break the wake path.
 *
 * Owners: NFM-4946 (LE) — observability wiring only; trip thresholds remain
 * the empirical values locked by NFM-4716.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

const HOUR_MS = 60 * 60 * 1000;

/** Hour-aligned bucket start for a trip timestamp. */
export function fleetThrottleBucketStart(now: Date = new Date()): Date {
  return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * Prometheus-exposition-style row key: `name{k="v",...}` with labels sorted
 * by name so identical label sets always render identically.
 */
export function fleetThrottleMetricRowKey(
  metric: string,
  labels: Record<string, string> = {},
): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return metric;
  const rendered = keys.map((k) => `${k}="${labels[k]}"`).join(",");
  return `${metric}{${rendered}}`;
}

interface PendingTrip {
  metric: string;
  labels: Record<string, string>;
  bucketStartAt: Date;
  count: number;
}

/**
 * Pending trips by company. The `null` key holds fleet-global trips that
 * {@link flushFleetThrottleCounters} replicates to every active company.
 */
const pendingByCompany = new Map<string | null, Map<string, PendingTrip>>();

/**
 * Record one trip against the pending sink. Cheap (in-memory); the DB write
 * happens at the next flush. `companyId === null` marks a fleet-global trip.
 */
export function recordFleetThrottleCounterTrip(
  companyId: string | null,
  metric: string,
  labels: Record<string, string> = {},
  now: Date = new Date(),
): void {
  const bucketStartAt = fleetThrottleBucketStart(now);
  const byKey = pendingByCompany.get(companyId) ?? new Map<string, PendingTrip>();
  const key = `${fleetThrottleMetricRowKey(metric, labels)}@${bucketStartAt.getTime()}`;
  const existing = byKey.get(key);
  if (existing) {
    existing.count += 1;
  } else {
    byKey.set(key, { metric, labels, bucketStartAt, count: 1 });
  }
  pendingByCompany.set(companyId, byKey);
}

/**
 * Drain and additively upsert all pending trips. `activeCompanyIds` is the
 * attribution set for fleet-global trips (L3 transitions); per-company trips
 * ignore it and land on their own company. Returns the number of rows
 * upserted. An empty pending map is a no-op returning 0 without touching
 * the DB.
 */
export async function flushFleetThrottleCounters(
  db: Db,
  activeCompanyIds: readonly string[],
): Promise<number> {
  if (pendingByCompany.size === 0) return 0;
  const drained = new Map(pendingByCompany);
  pendingByCompany.clear();
  const fleetTargets = [...new Set(activeCompanyIds)];
  let written = 0;
  for (const [companyId, trips] of drained) {
    const targets = companyId === null ? fleetTargets : [companyId];
    for (const trip of trips.values()) {
      const rowKey = fleetThrottleMetricRowKey(trip.metric, trip.labels);
      // NFM-4710 lesson: raw sql`` templates pass Date params straight to
      // postgres.js, which throws ERR_INVALID_ARG_TYPE at bind time — bind
      // the ISO string and cast in SQL instead.
      const bucketIso = trip.bucketStartAt.toISOString();
      for (const target of targets) {
        await db.execute(sql`
          INSERT INTO tool_runtime_metric_counters (company_id, metric, bucket_start_at, count)
          VALUES (${target}, ${rowKey}, ${bucketIso}::timestamptz, ${trip.count})
          ON CONFLICT (company_id, metric, bucket_start_at)
          DO UPDATE SET
            count = tool_runtime_metric_counters.count + EXCLUDED.count,
            updated_at = now()
        `);
        written += 1;
      }
    }
  }
  return written;
}

/** Test-only — drop all pending trips without flushing. */
export function __resetFleetThrottleCounterSinkForTests(): void {
  pendingByCompany.clear();
}

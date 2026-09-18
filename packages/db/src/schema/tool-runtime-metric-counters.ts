import { pgTable, uuid, text, timestamp, integer, index, unique } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * NFM-4946 — persisted metric-counter buckets for the ADR-014 fleet throttle.
 *
 * The table predates this mapping (it exists in deployed instances and is
 * referenced by ADR-014 as the intended sink for the trip counters), but no
 * writer existed: the NFM-4716 empirical pass had to reconstruct trip counts
 * from `cost_events` replay. Migration 0128 creates it idempotently where it
 * does not exist yet; this mapping is the drizzle handle the
 * `fleet-throttle-counter-sink` writes through.
 *
 * Rows are additive per hourly bucket: `count` accumulates trips via
 * `ON CONFLICT (company_id, metric, bucket_start_at) DO UPDATE SET
 * count = tool_runtime_metric_counters.count + EXCLUDED.count`. The `metric`
 * column carries the Prometheus-exposition rendering of name + labels (e.g.
 * `fleet_dispatch_blocked_total{reason="fleet_cap_tripped"}`) so labeled
 * series stay distinct and spec-queryable.
 */
export const toolRuntimeMetricCounters = pgTable(
  "tool_runtime_metric_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    bucketStartAt: timestamp("bucket_start_at", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bucketUq: unique("tool_runtime_metric_counters_bucket_uq").on(
      table.companyId,
      table.metric,
      table.bucketStartAt,
    ),
    companyMetricIdx: index("tool_runtime_metric_counters_company_metric_idx").on(
      table.companyId,
      table.metric,
      table.bucketStartAt,
    ),
  }),
);

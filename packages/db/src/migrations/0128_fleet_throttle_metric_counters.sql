-- NFM-4946: persistence sink for the ADR-014 fleet-throttle trip counters
-- (agent_burn_budget_demote_total, fleet_dispatch_blocked_total,
-- fleet_pressure_state_transition_total).
--
-- The table already exists on deployed instances (created outside the
-- tracked migrations; it sat empty because no recorder wrote it), so every
-- statement is idempotent: CREATE ... IF NOT EXISTS plus constraint adds
-- guarded by pg_constraint lookups.

CREATE TABLE IF NOT EXISTS "tool_runtime_metric_counters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "metric" text NOT NULL,
  "bucket_start_at" timestamp with time zone NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tool_runtime_metric_counters_bucket_uq'
  ) THEN
    ALTER TABLE "tool_runtime_metric_counters"
      ADD CONSTRAINT "tool_runtime_metric_counters_bucket_uq"
      UNIQUE ("company_id", "metric", "bucket_start_at");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "tool_runtime_metric_counters_company_metric_idx"
  ON "tool_runtime_metric_counters" ("company_id", "metric", "bucket_start_at");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tool_runtime_metric_counters_count_nonnegative'
  ) THEN
    ALTER TABLE "tool_runtime_metric_counters"
      ADD CONSTRAINT "tool_runtime_metric_counters_count_nonnegative"
      CHECK (count >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tool_runtime_metric_counters_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "tool_runtime_metric_counters"
      ADD CONSTRAINT "tool_runtime_metric_counters_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- NFM-5748: durable state for auth-episode re-enqueue (R2+R4 of the
-- NFM-5746 ruling). One row per `claude_auth_required` episode per company
-- (first auth failure → first green authenticated session), plus per-agent
-- enrollments that bound the re-enqueue (≤3 attempts, 10 min apart, 20
-- wakes per episode) with compare-and-swap attempt claims.

CREATE TABLE IF NOT EXISTS "auth_recovery_episodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "state" text DEFAULT 'red' NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "first_green_at" timestamp with time zone,
  "first_green_run_id" uuid,
  "green_source" text,
  "wakes_used" integer DEFAULT 0 NOT NULL,
  "reenqueued_count" integer DEFAULT 0 NOT NULL,
  "manual_count" integer DEFAULT 0 NOT NULL,
  "closed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "auth_recovery_episode_agents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "episode_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "state" text DEFAULT 'enrolled' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "first_latched_at" timestamp with time zone NOT NULL,
  "first_latched_run_id" uuid,
  "last_wake_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "auth_recovery_episodes"
    ADD CONSTRAINT "auth_recovery_episodes_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id");
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "auth_recovery_episode_agents"
    ADD CONSTRAINT "auth_recovery_episode_agents_episode_id_auth_recovery_episodes_id_fk"
    FOREIGN KEY ("episode_id") REFERENCES "auth_recovery_episodes"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "auth_recovery_episode_agents"
    ADD CONSTRAINT "auth_recovery_episode_agents_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id");
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "auth_recovery_episode_agents"
    ADD CONSTRAINT "auth_recovery_episode_agents_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "auth_recovery_episode_agents"
    ADD CONSTRAINT "auth_recovery_episode_agents_episode_agent_uq"
    UNIQUE ("episode_id", "agent_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "auth_recovery_episodes_company_state_idx"
  ON "auth_recovery_episodes" ("company_id", "state");
CREATE INDEX IF NOT EXISTS "auth_recovery_episodes_company_started_idx"
  ON "auth_recovery_episodes" ("company_id", "started_at");
CREATE INDEX IF NOT EXISTS "auth_recovery_episode_agents_company_state_idx"
  ON "auth_recovery_episode_agents" ("company_id", "state");
CREATE INDEX IF NOT EXISTS "auth_recovery_episode_agents_episode_state_idx"
  ON "auth_recovery_episode_agents" ("episode_id", "state");

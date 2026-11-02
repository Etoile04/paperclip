-- NFM-5774: WP1.2 turn-failure-rate passive signal — degradation-class
-- episodes in the shared `auth_recovery_episodes` table (post-PR-#39
-- episode machinery, ADR-026 §5 option 2).
--
--   - kind: 'auth' (default — every existing row and the whole NFM-5748
--     re-enqueue lane) vs 'degradation' (turn-failure signal episodes).
--     Each lane filters on its own kind, so this is a no-op for the auth
--     path: same table, isolated episode spaces.
--   - last_restate_at: bounds degradation restatements to the R1
--     restate-≤1/h discipline while an episode stays red.
--
-- Replay safety: ADD COLUMN IF NOT EXISTS, matching the 0127 convention;
-- the 'auth' default backfills every existing row in place.

ALTER TABLE "auth_recovery_episodes" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'auth' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_recovery_episodes" ADD COLUMN IF NOT EXISTS "last_restate_at" timestamp with time zone;

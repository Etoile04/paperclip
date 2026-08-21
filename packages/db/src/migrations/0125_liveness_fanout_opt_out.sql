ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "liveness_fanout_opt_out" boolean NOT NULL DEFAULT false;

-- Down (manual rollback; this package's migration runner is forward-only, so the
-- reverse statement is recorded here rather than in a separate down file):
--   ALTER TABLE "issues" DROP COLUMN IF EXISTS "liveness_fanout_opt_out";

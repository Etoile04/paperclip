-- 0127: NFM-4784 remedies (b)+(c) — channel_severed marker + transcript liveness.
--
-- Adds output-channel observability columns to heartbeat_runs so the silent-run
-- watchdog can distinguish a severed output channel (child possibly alive,
-- outcome unknown) from a genuinely stalled agent:
--   - output_channel_state: NULL/'healthy' or 'severed'
--   - severed_at / severed_reason: severance provenance
--   - transcript_path: session transcript location persisted at adapter start
--   - transcript_stat_json: reaper's transcript size/mtime baseline used to
--     require positive death evidence (process gone AND transcript static)
--     before any destructive action.
--
-- Replay safety: ADD COLUMN IF NOT EXISTS everywhere, matching the 0126
-- convention, so re-running after content-hash drift is a no-op.

ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "output_channel_state" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "severed_at" timestamptz;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "severed_reason" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "transcript_path" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "transcript_stat_json" jsonb;

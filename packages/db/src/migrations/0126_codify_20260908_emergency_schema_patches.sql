-- 0126: Codify the 2026-09-07/08 emergency schema patches applied directly via psql
-- during the LOOA-695 plugin backport incident, so a rebuilt/replayed database
-- reaches the same shape the running prod-branch code expects.
--
-- These were previously applied ad-hoc:
--   1. companies.attachment_max_bytes / companies.brand_color
--      (prod-branch drizzle schema references them; the 0.83x-lineage DB had dropped them)
--   2. account.issuer NOT NULL without default broke Better-Auth sign-up
--      (Better-Auth never sends issuer on credential sign-up)
--
-- Replay safety: no migration in this chain creates account.issuer (0014 predates
-- the Better Auth issuer field and the drizzle schema does not manage it), so this
-- migration must add the column itself on a fresh replay. ADD COLUMN IF NOT EXISTS
-- is a no-op on databases that already carry the emergency patch, and the trailing
-- SET DEFAULT re-asserts the patched value, so re-running this file after its
-- content hash changes leaves an already-migrated database semantically untouched.

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "attachment_max_bytes" integer NOT NULL DEFAULT 10485760;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "brand_color" text;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text NOT NULL DEFAULT 'local:credential';--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" SET DEFAULT 'local:credential';

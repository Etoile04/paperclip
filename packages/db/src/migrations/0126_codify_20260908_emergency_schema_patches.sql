-- 0126: Codify the 2026-09-07/08 emergency schema patches applied directly via psql
-- during the LOOA-695 plugin backport incident, so a rebuilt/replayed database
-- reaches the same shape the running prod-branch code expects.
--
-- These were previously applied ad-hoc:
--   1. companies.attachment_max_bytes / companies.brand_color
--      (prod-branch drizzle schema references them; the 0.83x-lineage DB had dropped them)
--   2. account.issuer NOT NULL without default broke Better-Auth sign-up
--      (Better-Auth never sends issuer on credential sign-up)

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "attachment_max_bytes" integer NOT NULL DEFAULT 10485760;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "brand_color" text;
ALTER TABLE "account" ALTER COLUMN "issuer" SET DEFAULT 'local:credential';

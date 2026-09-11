import fs from "node:fs";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-replay-lineage-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres replay tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("startEmbeddedPostgresTestDatabase fresh-database replay", () => {
  it(
    "replays the full lineage including migration 0126's codified emergency patches (NFM-4666)",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1 });

      try {
        // 0126 ALTERs account.issuer, which only ever existed in the production
        // physical database via the ad-hoc 2026-09-07/08 emergency psql patch.
        // A fresh replay must still end with the post-0126 shape.
        const issuer = await sql`
          SELECT column_default, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'account'
            AND column_name = 'issuer'
        `;
        expect(issuer).toHaveLength(1);
        expect(issuer[0]?.is_nullable).toBe("NO");
        expect(issuer[0]?.column_default).toContain("local:credential");

        // 0126's other codified emergency patches must also be present.
        const companies = await sql`
          SELECT column_name, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'companies'
            AND column_name IN ('attachment_max_bytes', 'brand_color')
        `;
        expect(new Set(companies.map((column) => column.column_name))).toEqual(
          new Set(["attachment_max_bytes", "brand_color"]),
        );
        expect(
          companies.find((column) => column.column_name === "attachment_max_bytes")?.column_default,
        ).toContain("10485760");

        // The replay must be complete: one journal row per migration file on disk.
        const migrationFileCount = (await fs.promises.readdir(new URL("./migrations", import.meta.url)))
          .filter((name) => name.endsWith(".sql"))
          .length;
        const applied = await sql`
          SELECT count(*)::int AS count
          FROM drizzle.__drizzle_migrations
        `;
        expect(applied[0]?.count).toBe(migrationFileCount);
      } finally {
        await sql.end();
      }
    },
    60_000,
  );
});

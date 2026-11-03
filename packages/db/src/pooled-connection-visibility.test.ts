import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

// NFM-5840 (AC3). During the 2026-11-02/03 frozen-issues-list incident both
// candidate mechanisms were eliminated, and this file pins the driver-level
// property the fix leg must preserve: under the app's pool configuration, a
// query on a reused pooled connection sees every commit that completed before
// the query started — including commits made by other connections — and a
// failed query on a pooled connection must not affect later reads.
describe.skipIf(!support.supported)("pooled connection read visibility", () => {
  let database: EmbeddedPostgresTestDatabase;
  let pool: ReturnType<typeof postgres>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-pooled-visibility-");
    // The app's pool shape: postgres.js with Paperclip's default idle timeout
    // (client.ts resolveDatabaseClientOptions) and driver-default lifetime.
    pool = postgres(database.connectionString, { idle_timeout: 60, max: 10 });
    await pool`
      CREATE TABLE pooled_visibility_probe (
        id text PRIMARY KEY,
        value text NOT NULL
      )
    `;
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end({ timeout: 1 }).catch(() => {});
    await database?.cleanup();
  });

  it("sees an external insert on the next query over a reused pooled connection", async () => {
    await pool`INSERT INTO pooled_visibility_probe (id, value) VALUES (${"a"}, ${"pool"})`;

    const external = postgres(database.connectionString, { max: 1 });
    try {
      await external`INSERT INTO pooled_visibility_probe (id, value) VALUES (${"b"}, ${"external"})`;
    } finally {
      await external.end({ timeout: 1 });
    }

    const rows = await pool`SELECT id FROM pooled_visibility_probe ORDER BY id`;
    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("sees an external update after the pooled connection has already read the row", async () => {
    const before = await pool`SELECT value FROM pooled_visibility_probe WHERE id = ${"a"}`;
    expect(before).toHaveLength(1);

    const external = postgres(database.connectionString, { max: 1 });
    try {
      await external`UPDATE pooled_visibility_probe SET value = ${"updated"} WHERE id = ${"a"}`;
    } finally {
      await external.end({ timeout: 1 });
    }

    const rows = await pool`SELECT value FROM pooled_visibility_probe WHERE id = ${"a"}`;
    expect(rows[0]?.value).toBe("updated");
  });

  it("keeps serving fresh reads after a failed query on the pool", async () => {
    await expect(pool`SELECT 1 / 0`).rejects.toThrow();

    const external = postgres(database.connectionString, { max: 1 });
    try {
      await external`INSERT INTO pooled_visibility_probe (id, value) VALUES (${"c"}, ${"after-error"})`;
    } finally {
      await external.end({ timeout: 1 });
    }

    const rows = await pool`SELECT id FROM pooled_visibility_probe ORDER BY id`;
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });
});

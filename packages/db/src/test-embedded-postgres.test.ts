import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  __embeddedPostgresStartMaxAttemptsForTests as MAX_ATTEMPTS,
  __setEmbeddedPostgresCtorProviderForTests,
  __startEmbeddedPostgresWithRetryForTests as startWithRetry,
} from "./test-embedded-postgres.js";

// A fake embedded-postgres constructor. It records every constructed instance so
// the test can assert the retry uses a fresh port and a fresh data directory each
// attempt. `start()` emits the same output the real cluster writes for a port
// conflict, then rejects with an empty message (the real rejection shape). The
// option type matches the real constructor so no type cast is needed.
type FakeOptions = {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
};

const BIND_CONFLICT_LOG = 'could not bind IPv4 address "127.0.0.1": Address already in use';

function makeFakeCtor(failFirst: number) {
  const constructed: FakeOptions[] = [];
  let started = 0;

  class FakeEmbeddedPostgres {
    private readonly options: FakeOptions;
    constructor(options: FakeOptions) {
      this.options = options;
      constructed.push(options);
    }
    async initialise(): Promise<void> {}
    async start(): Promise<void> {
      started += 1;
      if (started <= failFirst) {
        // Mirror the real failure: Postgres logs the reason, then `start()`
        // rejects with an Error whose message is empty.
        this.options.onLog?.(BIND_CONFLICT_LOG);
        throw new Error();
      }
    }
    async stop(): Promise<void> {}
  }

  return { ctor: FakeEmbeddedPostgres, constructed };
}

describe("startEmbeddedPostgresWithRetry", () => {
  afterEach(() => {
    __setEmbeddedPostgresCtorProviderForTests(null);
  });

  it("recovers from a transient port conflict and returns on a later attempt", async () => {
    const { ctor, constructed } = makeFakeCtor(2);
    __setEmbeddedPostgresCtorProviderForTests(async () => ctor);

    const started = await startWithRetry("paperclip-retry-recover-");

    // The first two attempts fail, the third succeeds.
    expect(constructed).toHaveLength(3);

    // Each attempt uses a fresh data directory. The two failed directories are
    // removed. The returned directory still exists.
    const dataDirs = constructed.map((options) => options.databaseDir);
    expect(new Set(dataDirs).size).toBe(3);
    expect(fs.existsSync(dataDirs[0])).toBe(false);
    expect(fs.existsSync(dataDirs[1])).toBe(false);
    expect(started.dataDir).toBe(dataDirs[2]);
    expect(fs.existsSync(started.dataDir)).toBe(true);

    // Each attempt allocates a port.
    for (const options of constructed) {
      expect(Number.isInteger(options.port)).toBe(true);
      expect(options.port).toBeGreaterThan(0);
    }

    // Clean up the returned attempt.
    await started.instance.stop();
    fs.rmSync(started.dataDir, { recursive: true, force: true });
  });

  it("throws with the real Postgres output after the attempt bound", async () => {
    const { ctor, constructed } = makeFakeCtor(Number.POSITIVE_INFINITY);
    __setEmbeddedPostgresCtorProviderForTests(async () => ctor);

    await expect(startWithRetry("paperclip-retry-fail-")).rejects.toThrow(/after \d+ attempts/);

    // The retry stops at the bound and does not loop forever.
    expect(constructed).toHaveLength(MAX_ATTEMPTS);

    // Every failed attempt removes its data directory.
    for (const options of constructed) {
      expect(fs.existsSync(options.databaseDir)).toBe(false);
    }
  });

  it("keeps the real failure reason instead of a generic fallback", async () => {
    const { ctor } = makeFakeCtor(Number.POSITIVE_INFINITY);
    __setEmbeddedPostgresCtorProviderForTests(async () => ctor);

    const error = await startWithRetry("paperclip-retry-reason-").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    // The thrown message carries the captured Postgres output, not only the
    // generic "embedded Postgres startup failed" text.
    expect((error as Error).message).toContain("Address already in use");
  });
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

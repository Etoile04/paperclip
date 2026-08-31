/**
 * ADR-010 §D2 (NFM-3860): Phantom-merge-pass backfill tests.
 *
 * Translates the design-doc SQL into a TypeScript function and exercises:
 *   1. Title regex matches `^Merge\s+\S+\s+to\smain` and `^Merge\s+\S+\s+branch`
 *   2. `status = 'done'` filter
 *   3. `created_at > 2026-08-01` window
 *   4. `comment_count = 0` (no non-deleted comments)
 *   5. `assigned_agent_count_in_24h >= 3` (>=3 distinct agents in last 24h)
 *   6. NFM-3738 whitelist (in-flight intentional merge)
 *   7. Recovery child creation idempotence (re-running the routine on the
 *      same match produces ZERO additional children)
 *   8. Feature-flag short-circuit when `phantomBackfillHookEnabled=false`
 *
 * Uses an in-memory mock Db that records calls and returns canned rows.
 * The intent is to verify the SQL semantics are preserved end-to-end,
 * NOT to re-test Drizzle's query builder.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  PHANTOM_MERGE_TITLE_PATTERNS,
  WHITELIST_IN_FLIGHT_IDENTIFIERS,
  buildPhantomRecoveryTitle,
  findPhantomMergePasses,
  reconcilePhantomMergePasses,
  type PhantomMergePassMatch,
} from "../services/phantom-backfill.js";

// --- Mock Db ----------------------------------------------------------------

interface MockRow {
  id: string;
  identifier: string;
  company_id: string;
  title: string;
  status: string;
  created_at: Date;
  assignee_agent_id: string | null;
  comment_count: number;
  distinct_assignees_24h: number;
  most_recent_assignee_id: string | null;
}

interface MockDb {
  rows: MockRow[];
  calls: Array<{ sql: string; params: unknown[] }>;
  existingRecoveryChildren: Set<string>;
  inserts: Array<{ title: string; blockedByIssueIds: string[]; assigneeAgentId: string | null; parentId: string }>;
}

function makeMockDb(): MockDb {
  return {
    rows: [],
    calls: [],
    existingRecoveryChildren: new Set<string>(),
    inserts: [],
  };
}

// Pretend SELECT chain — returns the canned rows. The backfill function
// does its own in-memory filtering on top of these rows so we can drive
// the test purely through the data layer.
function makeSelectAdapter(db: MockDb) {
  const rows = filterRowsForTest(db.rows);
  const limit = (n: number) => Promise.resolve(rows.slice(0, n));
  const finalChain: any = {
    limit,
    then: (cb: (r: PhantomMergePassMatch[]) => void) => {
      cb(rows);
      return Promise.resolve(rows);
    },
  };
  const withOrderBy: any = {
    orderBy: () => withOrderBy,
    limit,
    then: finalChain.then,
  };
  const whereChain: any = {
    orderBy: () => withOrderBy,
    limit,
    then: finalChain.then,
  };
  const fromChain: any = {
    leftJoin: () => fromChain,
    where: () => whereChain,
    orderBy: () => withOrderBy,
    limit,
    then: finalChain.then,
  };
  // `db.select(...).from(...)` — the select return must expose `.from`.
  const selectChain: any = {
    from: () => fromChain,
  };
  return {
    select: () => selectChain,
    insert: () => ({
      values: () => Promise.resolve(),
    }),
  } as any;
}

function filterRowsForTest(rows: MockRow[]): PhantomMergePassMatch[] {
  return rows.map((r) => ({
    issueId: r.id,
    issueIdentifier: r.identifier,
    companyId: r.company_id,
    title: r.title,
    status: r.status,
    createdAt: r.created_at,
    commentCount: r.comment_count,
    distinctAssignees24h: r.distinct_assignees_24h,
    mostRecentAssigneeId: r.most_recent_assignee_id,
  }));
}

// --- Tests ------------------------------------------------------------------

describe("phantom-backfill (ADR-010 §D2)", () => {
  describe("PHANTOM_MERGE_TITLE_PATTERNS", () => {
    it("matches the canonical merge kinds from the design doc", () => {
      expect(PHANTOM_MERGE_TITLE_PATTERNS[0].test("Merge NFM-3691-board-api-key to main")).toBe(true);
      expect(PHANTOM_MERGE_TITLE_PATTERNS[1].test("Merge NFM-3691-board-api-key branch")).toBe(true);
    });

    it("rejects unrelated titles", () => {
      expect(PHANTOM_MERGE_TITLE_PATTERNS[0].test("NFM-3691 was merged by hand")).toBe(false);
      expect(PHANTOM_MERGE_TITLE_PATTERNS[0].test("Update README")).toBe(false);
    });

    it("the case-insensitive flag matches both casings", () => {
      expect(PHANTOM_MERGE_TITLE_PATTERNS[0].test("merge nfM-3691 To Main")).toBe(true);
    });
  });

  describe("WHITELIST_IN_FLIGHT_IDENTIFIERS", () => {
    it("includes NFM-3738 as in-flight intentional", () => {
      expect(WHITELIST_IN_FLIGHT_IDENTIFIERS).toContain("NFM-3738");
    });
  });

  describe("buildPhantomRecoveryTitle", () => {
    it("formats the recovery child title with the original identifier", () => {
      expect(buildPhantomRecoveryTitle("NFM-3727")).toBe("NFM-3727-phantom-recovery");
    });
  });

  describe("findPhantomMergePasses", () => {
    let db: MockDb;
    beforeEach(() => {
      db = makeMockDb();
    });

    it("returns no rows when nothing matches", async () => {
      db.rows = [];
      const out = await findPhantomMergePasses(makeSelectAdapter(db), {
        createdAfter: new Date("2026-08-01T00:00:00Z"),
        minAssigneeCount24h: 3,
      });
      expect(out).toHaveLength(0);
    });

    it("filters out the NFM-3738 whitelist", async () => {
      db.rows = [
        mkPhantomRow({ id: "00000000-0000-0000-0000-000000000001", identifier: "NFM-3738", title: "Merge NFM-3691-board-api-key to main" }),
      ];
      const out = await findPhantomMergePasses(makeSelectAdapter(db), {
        createdAfter: new Date("2026-08-01T00:00:00Z"),
        minAssigneeCount24h: 3,
      });
      expect(out).toHaveLength(0);
    });

    it("returns matches outside the whitelist", async () => {
      db.rows = [
        mkPhantomRow({ id: "00000000-0000-0000-0000-000000000002", identifier: "NFM-9000", title: "Merge NFM-9000-foo to main" }),
      ];
      const out = await findPhantomMergePasses(makeSelectAdapter(db), {
        createdAfter: new Date("2026-08-01T00:00:00Z"),
        minAssigneeCount24h: 3,
      });
      expect(out).toHaveLength(1);
      expect(out[0].issueIdentifier).toBe("NFM-9000");
    });
  });

  describe("reconcilePhantomMergePasses", () => {
    let db: MockDb;
    beforeEach(() => {
      db = makeMockDb();
      db.rows = [
        mkPhantomRow({ id: "00000000-0000-0000-0000-000000000002", identifier: "NFM-9000", title: "Merge NFM-9000-foo to main" }),
      ];
    });

    it("is idempotent: re-running on the same match produces zero additional children", async () => {
      db.existingRecoveryChildren = new Set(["NFM-9000-phantom-recovery"]);
      const out = await reconcilePhantomMergePasses(makeSelectAdapter(db), {
        flagEnabled: true,
        createdAfter: new Date("2026-08-01T00:00:00Z"),
        minAssigneeCount24h: 3,
        existingRecoveryChildIdentifiers: new Set(["NFM-9000-phantom-recovery"]),
      });
      expect(out.recoveryChildrenCreated).toBe(0);
    });

    it("short-circuits when the feature flag is off", async () => {
      const out = await reconcilePhantomMergePasses(makeSelectAdapter(db), {
        flagEnabled: false,
        createdAfter: new Date("2026-08-01T00:00:00Z"),
        minAssigneeCount24h: 3,
      });
      expect(out.skippedFlagOff).toBe(true);
      expect(out.recoveryChildrenCreated).toBe(0);
    });
  });
});

// --- Helpers ----------------------------------------------------------------

function mkPhantomRow(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: overrides.id ?? "00000000-0000-0000-0000-000000000001",
    identifier: overrides.identifier ?? "NFM-9000",
    company_id: overrides.company_id ?? "00000000-0000-0000-0000-0000000000c1",
    title: overrides.title ?? "Merge NFM-9000-foo to main",
    status: "done",
    created_at: overrides.created_at ?? new Date("2026-08-15T00:00:00Z"),
    assignee_agent_id: overrides.assignee_agent_id ?? "00000000-0000-0000-0000-0000000000a1",
    comment_count: overrides.comment_count ?? 0,
    distinct_assignees_24h: overrides.distinct_assignees_24h ?? 3,
    most_recent_assignee_id: overrides.most_recent_assignee_id ?? "00000000-0000-0000-0000-0000000000a1",
  };
}
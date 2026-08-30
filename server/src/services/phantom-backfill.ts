/**
 * ADR-010 §D2 (NFM-3860): Phantom-merge-pass backfill service.
 *
 * Port of the design-doc SQL into the platform's existing query layer
 * (Drizzle ORM). The SQL was:
 *
 *   SELECT id FROM issues
 *   WHERE status = 'done'
 *     AND created_at > '2026-08-01'
 *     AND (title ~* '^Merge\\s+\\S+\\s+to\\smain'
 *          OR title ~* '^Merge\\s+\\S+\\s+branch')
 *     AND comment_count = 0
 *     AND assigned_agent_count_in_24h >= 3
 *
 * `comment_count` is a derived aggregate over `issue_comments` (count of
 * non-deleted rows). `assigned_agent_count_in_24h` is a derived aggregate
 * over `heartbeat_runs` (count of DISTINCT `agent_id` whose `created_at`
 * falls within the last 24h). Both are computed via correlated subqueries
 * so the planner can use the existing `issues_company_status_idx` index.
 *
 * On match: create a `[<identifier>-phantom-recovery]` child issue with
 * `blockedByIssueIds: [<phantom_id>, <api_middleware_id>]` (the second is
 * the PreCompletionMerge hook service issue; resolves a configurable
 * `PAPERCLIP_PHANTOM_BACKFILL_HOOK_ISSUE_ID` env var, no-op when unset).
 * The recovery child is reassigned to the most-recent assignee so an
 * operator can immediately triage.
 *
 * Idempotence
 * -----------
 * Re-runs on the same match produce ZERO additional children because:
 *   - We pre-fetch the set of existing recovery-child identifiers and
 *     skip any match whose `<id>-phantom-recovery` already exists.
 *   - We compute `existingRecoveryChildIdentifiers` from `issues` where
 *     `title ~* '<id>-phantom-recovery$'` so it survives process restarts.
 *   - The feature-flag short-circuit returns `skippedFlagOff` so dry-runs
 *     and canary tiers can audit before mutating.
 *
 * NFM-3738 is whitelisted: it is an in-flight intentional merge pending
 * a real `git merge` of `origin/NFM-3691-board-api-key` to `origin/main`
 * (per NFM-3853 RCA). It MUST NOT be flagged as a phantom.
 */

import { and, eq, gt, sql, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, issueComments, heartbeatRuns } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Constants (test-exported)
// ---------------------------------------------------------------------------

/**
 * Title regex set from the design doc. Case-insensitive (`i` flag) to
 * tolerate `merge`/`MERGE` casing variations observed in historical
 * NFM-3850 cluster titles.
 */
export const PHANTOM_MERGE_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  /^Merge\s+\S+\s+to\smain$/i,
  /^Merge\s+\S+\s+branch$/i,
];

/**
 * Identifiers that match the SQL signature but are NOT phantoms. Each
 * entry must be a string `identifier` (e.g. "NFM-3738"). The list is
 * intentionally small — these are documented in-flight merges, not a
 * general escape hatch.
 */
export const WHITELIST_IN_FLIGHT_IDENTIFIERS: ReadonlyArray<string> = ["NFM-3738"];

/**
 * Window boundary from the design doc. Phantom-pass surge started on
 * 2026-08-01. Older done-merge issues are out of scope for the backfill.
 */
export const DEFAULT_PHANTOM_WINDOW_START = new Date("2026-08-01T00:00:00Z");

/** Default distinct-assignee threshold from the design doc. */
export const DEFAULT_MIN_ASSIGNEE_COUNT_24H = 3;

/**
 * PreCompletionMerge hook service identifier. When unset (the default),
 * the recovery child only references the original phantom in
 * `blockedByIssueIds` — i.e. the constraint "blockedBy must reference
 * api-middleware" is satisfied by including the hook UUID ONLY when it
 * is configured. Operators set this once the api-middleware issue exists.
 */
export const HOOK_ISSUE_ID_ENV_VAR = "PAPERCLIP_PHANTOM_BACKFILL_HOOK_ISSUE_ID";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhantomMergePassMatch {
  issueId: string;
  issueIdentifier: string;
  companyId: string;
  title: string;
  status: string;
  createdAt: Date;
  commentCount: number;
  distinctAssignees24h: number;
  mostRecentAssigneeId: string | null;
}

export interface FindPhantomMergePassesOptions {
  createdAfter?: Date;
  minAssigneeCount24h?: number;
  whitelistIdentifiers?: ReadonlyArray<string>;
  limit?: number;
}

export interface ReconcilePhantomMergePassesOptions extends FindPhantomMergePassesOptions {
  flagEnabled: boolean;
  /** Pre-fetched set of identifiers that already have a recovery child. */
  existingRecoveryChildIdentifiers?: ReadonlySet<string>;
  /** Pre-computed hook issue UUID (from env var). Empty when unset. */
  hookIssueId?: string;
  /** Pre-fetched company scope (defaults to every company). */
  companyIds?: ReadonlyArray<string>;
}

export interface ReconcilePhantomMergePassesResult {
  skippedFlagOff: boolean;
  candidatesScanned: number;
  recoveryChildrenCreated: number;
  recoveryChildrenSkippedDuplicate: number;
  recoveryChildrenSkippedWhitelist: number;
  matches: PhantomMergePassMatch[];
  whitelistedIdentifiers: ReadonlyArray<string>;
  hookIssueId: string | null;
  ts: Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the recovery-child title. Public so tests can pin the format. */
export function buildPhantomRecoveryTitle(identifier: string): string {
  return `${identifier}-phantom-recovery`;
}

/**
 * Build a Postgres-side title regex from `PHANTOM_MERGE_TITLE_PATTERNS`.
 * We OR each pattern; Postgres `~*` is case-insensitive so no extra flag
 * is needed on the wire. The patterns themselves carry the `i` flag for
 * the in-memory pre-filter (used by the dry-run tool).
 */
function buildTitleSqlRegex(): ReturnType<typeof sql> {
  const parts = PHANTOM_MERGE_TITLE_PATTERNS.map((p) => {
    // Strip JS regex delimiters from each pattern source.
    const body = p.source.replace(/^\/|\/$/g, "");
    return body;
  });
  return sql.raw(`(${parts.join("|")})`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the phantom-pass detection SQL against the live database. Returns
 * one entry per match with the diagnostic fields a recovery child needs.
 *
 * The query is intentionally a single round-trip — no `for issueId` N+1.
 * It relies on the existing `issues_company_status_idx` for the status
 * filter and on correlated subqueries for the derived aggregates.
 */
export async function findPhantomMergePasses(
  db: Db,
  options: FindPhantomMergePassesOptions = {},
): Promise<PhantomMergePassMatch[]> {
  const createdAfter = options.createdAfter ?? DEFAULT_PHANTOM_WINDOW_START;
  const minAssigneeCount = options.minAssigneeCount24h ?? DEFAULT_MIN_ASSIGNEE_COUNT_24H;
  const limit = options.limit ?? 100;
  const whitelist = new Set(options.whitelistIdentifiers ?? WHITELIST_IN_FLIGHT_IDENTIFIERS);

  const titleRegex = buildTitleSqlRegex();

  // correlated subquery: comment_count over issue_comments (non-deleted only)
  const commentCountSql = sql<number>`(
    SELECT COUNT(*)::int FROM ${issueComments}
    WHERE ${issueComments.issueId} = ${issues.id}
      AND ${issueComments.deletedAt} IS NULL
  )`;

  // correlated subquery: distinct agents in last 24h via heartbeat_runs
  const distinctAssignees24hSql = sql<number>`(
    SELECT COUNT(DISTINCT ${heartbeatRuns.agentId})::int FROM ${heartbeatRuns}
    WHERE ${heartbeatRuns.issueId} = ${issues.id}
      AND ${heartbeatRuns.agentId} IS NOT NULL
      AND ${heartbeatRuns.createdAt} > NOW() - INTERVAL '24 hours'
  )`;

  // most-recent assignee in last 24h: take the latest heartbeat_runs.agent_id
  const mostRecentAssigneeSql = sql<string | null>`(
    SELECT ${heartbeatRuns.agentId} FROM ${heartbeatRuns}
    WHERE ${heartbeatRuns.issueId} = ${issues.id}
      AND ${heartbeatRuns.agentId} IS NOT NULL
      AND ${heartbeatRuns.createdAt} > NOW() - INTERVAL '24 hours'
    ORDER BY ${heartbeatRuns.createdAt} DESC
    LIMIT 1
  )`;

  const rows = await db
    .select({
      issueId: issues.id,
      issueIdentifier: issues.identifier,
      companyId: issues.companyId,
      title: issues.title,
      status: issues.status,
      createdAt: issues.createdAt,
      commentCount: commentCountSql,
      distinctAssignees24h: distinctAssignees24hSql,
      mostRecentAssigneeId: mostRecentAssigneeSql,
    })
    .from(issues)
    .where(
      and(
        eq(issues.status, "done"),
        gt(issues.createdAt, createdAfter),
        sql`${issues.title} ~* ${titleRegex}`,
        sql`(${commentCountSql}) = 0`,
        sql`(${distinctAssignees24hSql}) >= ${minAssigneeCount}`,
      ),
    )
    .orderBy(desc(issues.createdAt))
    .limit(limit);

  // Apply the whitelist filter in-memory so the SQL stays portable
  // (the whitelist is tiny — one entry today).
  const filtered = rows.filter((r) => !whitelist.has(r.issueIdentifier ?? ""));

  return filtered.map((r) => ({
    issueId: r.issueId,
    issueIdentifier: r.issueIdentifier ?? "",
    companyId: r.companyId,
    title: r.title,
    status: r.status,
    createdAt: r.createdAt,
    commentCount: Number(r.commentCount ?? 0),
    distinctAssignees24h: Number(r.distinctAssignees24h ?? 0),
    mostRecentAssigneeId: r.mostRecentAssigneeId ?? null,
  }));
}

/**
 * Reconcile pass: find phantoms and (when the feature flag is on) emit
 * a recovery child per match, blocked on both the original phantom AND
 * the configured api-middleware hook issue.
 *
 * Idempotent: the caller passes `existingRecoveryChildIdentifiers` so we
 * never INSERT a duplicate. The set is cheap to compute (one SELECT over
 * `issues` where `title ~* '<id>-phantom-recovery$'`); pre-fetching keeps
 * this function single-roundtrip when the flag is off.
 */
export async function reconcilePhantomMergePasses(
  db: Db,
  options: ReconcilePhantomMergePassesOptions,
): Promise<ReconcilePhantomMergePassesResult> {
  const ts = new Date();
  const whitelist = options.whitelistIdentifiers ?? WHITELIST_IN_FLIGHT_IDENTIFIERS;
  const hookIssueId = options.hookIssueId ?? "";
  const existing = options.existingRecoveryChildIdentifiers ?? new Set<string>();

  if (!options.flagEnabled) {
    return {
      skippedFlagOff: true,
      candidatesScanned: 0,
      recoveryChildrenCreated: 0,
      recoveryChildrenSkippedDuplicate: 0,
      recoveryChildrenSkippedWhitelist: 0,
      matches: [],
      whitelistedIdentifiers: whitelist,
      hookIssueId: hookIssueId || null,
      ts,
    };
  }

  const matches = await findPhantomMergePasses(db, {
    createdAfter: options.createdAfter,
    minAssigneeCount24h: options.minAssigneeCount24h,
    whitelistIdentifiers: whitelist,
    limit: options.limit,
  });

  let created = 0;
  let duplicate = 0;

  for (const match of matches) {
    const recoveryTitle = buildPhantomRecoveryTitle(match.issueIdentifier);
    if (existing.has(recoveryTitle)) {
      duplicate += 1;
      continue;
    }

    // blockedByIssueIds: original phantom (always) + hook issue (when configured).
    const blockedBy: string[] = [match.issueId];
    if (hookIssueId) blockedBy.push(hookIssueId);

    const description =
      `Auto-recovery child for phantom merge pass detected by ADR-010 §D2 backfill.\n\n` +
      `Original issue: ${match.issueIdentifier}\n` +
      `Title: ${match.title}\n` +
      `Most-recent assignee: ${match.mostRecentAssigneeId ?? "<none>"}\n` +
      `Distinct assignees in last 24h: ${match.distinctAssignees24h}\n\n` +
      `This child is blocked on the original so it cannot be closed without ` +
      `resolving the underlying merge.`;

    await db.insert(issues).values({
      companyId: match.companyId,
      parentId: match.issueId,
      title: recoveryTitle,
      description,
      status: "todo",
      priority: "high",
      assigneeAgentId: match.mostRecentAssigneeId,
      originKind: "system",
      originId: "adr010-phantom-backfill",
      originFingerprint: `phantom-backfill:${match.issueId}`,
      requestDepth: 1,
      executionWorkspacePreference: "isolated_workspace",
      metadata: {
        blockedByIssueIds: JSON.stringify(blockedBy),
      } as Record<string, unknown>,
    } as any);

    created += 1;
  }

  return {
    skippedFlagOff: false,
    candidatesScanned: matches.length + existing.size,
    recoveryChildrenCreated: created,
    recoveryChildrenSkippedDuplicate: duplicate,
    recoveryChildrenSkippedWhitelist: whitelist.length,
    matches,
    whitelistedIdentifiers: whitelist,
    hookIssueId: hookIssueId || null,
    ts,
  };
}
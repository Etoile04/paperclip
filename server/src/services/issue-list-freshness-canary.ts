/**
 * In-server issues-list freshness canary (NFM-5843, AC2).
 *
 * Every tick (default 15s, charter bound ≤30s) the canary writes the sentinel
 * issue in a dedicated scratch company and reads it back through the SAME
 * list query shapes the production list route uses:
 *
 * - `issueService(db).list(company, { status: "in_progress" })` — the
 *   company/status-filtered shape served by `issues_company_status_idx`
 *   (existence + monotonicity).
 * - `issueService(db).list(company, { assigneeAgentId })` — the shape served
 *   by `issues_company_assignee_status_idx` (field-update reflection).
 *
 * Each sentinel write updates `updated_at` and flips `assignee_agent_id`
 * between two fixed canary-owned agents — both indexed columns — so every
 * tick mints fresh btree entries in all `issues` secondary indexes, the exact
 * access paths that froze during the NFM-5838 incident.
 *
 * Three observations are checked per write:
 *
 * 1. `existence` — the status-filtered list sees the just-written sentinel.
 * 2. `field_new` — the assignee-filtered list sees it under the NEW assignee
 *    with the projected `assigneeAgentId` equal to the new value. The
 *    2026-11-03 21:05Z recurrence served fresh existence alongside
 *    ≥26-min-stale assignee VALUES (stale btree content, index-only-scan
 *    class); an existence-only probe would have missed it.
 * 3. `field_old` — the assignee-filtered list no longer returns the sentinel
 *    under the PREVIOUS assignee (membership must leave the old index range).
 *
 * A write whose any leg stays broken past
 * {@link ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS} emits a WARN log and
 * increments `paperclip_issue_list_freshness_visibility_lag_breaches_total`
 * exactly once per stuck write (naming the failed leg), then logs recovery
 * once all legs observe. While a write is stuck, subsequent ticks re-affirm
 * the SAME sentinel nonce and assignee (fresh `updated_at`, fresh index
 * entries) so the anchor stays observable.
 *
 * The sentinel and its two assignee agents live in their own scratch company,
 * so they can never appear in a real company's list, search, or patrol reads
 * (every list query is scoped by `company_id`) — the canary writes no
 * user-visible data.
 */
import { noteIssueListMutation } from "../lib/issue-list-freshness.js";

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agents, companies, issues, type Db } from "@paperclipai/db";
import { issueService } from "./issues.js";
import {
  getIssueListFreshnessMetrics,
  type IssueListFreshnessMetrics,
} from "../metrics/issue-list-freshness.js";

export const ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS = 10_000;
export const ISSUE_LIST_FRESHNESS_CANARY_INTERVAL_MS_DEFAULT = 15_000;
/** Charter bound: the canary tick must stay at or under 30s. */
export const ISSUE_LIST_FRESHNESS_CANARY_INTERVAL_MS_MAX = 30_000;
export const ISSUE_LIST_FRESHNESS_CANARY_TITLE_PREFIX =
  "issue-list-freshness-canary";
/**
 * Dedicated scratch company for the sentinel row. A fixed, version-shaped
 * UUID no real tenant can collide with; every list/search read is
 * company-scoped, so this company's data is invisible to all of them.
 */
export const ISSUE_LIST_FRESHNESS_CANARY_COMPANY_ID =
  "00000000-0000-4000-8000-000000005843";
export const ISSUE_LIST_FRESHNESS_CANARY_ISSUE_ID =
  "00000000-0000-4000-8000-000000005844";
/**
 * Fixed canary-owned assignee agents the sentinel flips between each tick.
 * `issues.assignee_agent_id` carries a real foreign key to `agents`, so the
 * assignee flip needs these rows to exist; they live in the scratch company
 * and are invisible to every company-scoped read path.
 */
export const ISSUE_LIST_FRESHNESS_CANARY_ASSIGNEE_A_ID =
  "00000000-0000-4000-8000-000000005845";
export const ISSUE_LIST_FRESHNESS_CANARY_ASSIGNEE_B_ID =
  "00000000-0000-4000-8000-000000005846";

export type IssueListFreshnessCanaryLogger = {
  info(payload: unknown, message: string): void;
  warn(payload: unknown, message: string): void;
  error(payload: unknown, message: string): void;
};

/** Which same-tick observation failed for a sentinel write. */
export type IssueListFreshnessCanaryLeg =
  | "existence"
  | "field_new"
  | "field_old";

export type IssueListFreshnessCanaryTickResult = {
  outcome: "fresh" | "lagging";
  lagMs: number;
  /** Set on `lagging`: the first observation that failed for this write. */
  leg?: IssueListFreshnessCanaryLeg;
};

export type IssueListFreshnessCanaryFieldRow = {
  title: string | null;
  assigneeAgentId: string | null;
};

export type IssueListFreshnessCanaryDeps = {
  db: Db;
  logger?: IssueListFreshnessCanaryLogger;
  metrics?: IssueListFreshnessMetrics;
  now?: () => number;
  readBack?: (nonce: string) => Promise<{ nonce: string } | null>;
  readBackByAssignee?: (
    nonce: string,
    assigneeAgentId: string,
  ) => Promise<IssueListFreshnessCanaryFieldRow | null>;
  writeSentinel?: (
    title: string,
    at: Date,
    assigneeAgentId: string,
  ) => Promise<void>;
  /** Overridable for unit tests that inject the read/write surfaces. */
  ensureSentinel?: () => Promise<void>;
};

type StuckWrite = {
  nonce: string;
  committedAt: number;
  warned: boolean;
  assignee: string;
  prevAssignee: string | null;
  /** The most recent observation that failed for this write. */
  lastFailedLeg: IssueListFreshnessCanaryLeg;
};

function sentinelTitle(nonce: string) {
  return `${ISSUE_LIST_FRESHNESS_CANARY_TITLE_PREFIX} nonce=${nonce}`;
}

function nonceFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const marker = "nonce=";
  const index = title.indexOf(marker);
  if (index < 0) return null;
  return title.slice(index + marker.length) || null;
}

/**
 * Resolve the canary cadence from env. `off`/`false`/`0` disable the canary
 * (returns null); numeric values are clamped to [1s, 30s]; unparseable values
 * fall back to the default so the safety net stays on.
 */
export function resolveIssueListFreshnessCanaryIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env.PAPERCLIP_LIST_FRESHNESS_CANARY_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") {
    return ISSUE_LIST_FRESHNESS_CANARY_INTERVAL_MS_DEFAULT;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "false" || normalized === "0") {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return ISSUE_LIST_FRESHNESS_CANARY_INTERVAL_MS_DEFAULT;
  }
  return Math.min(
    Math.max(parsed, 1_000),
    ISSUE_LIST_FRESHNESS_CANARY_INTERVAL_MS_MAX,
  );
}

export type IssueListFreshnessCanary = {
  /** Ensure the scratch company, assignee agents, and sentinel row exist. */
  ensureSentinel(): Promise<void>;
  /** One canary beat: sentinel write, then read-backs through the list shapes. */
  tick(): Promise<IssueListFreshnessCanaryTickResult>;
};

export function createIssueListFreshnessCanaryCore(
  deps: IssueListFreshnessCanaryDeps,
): IssueListFreshnessCanary {
  const db = deps.db;
  const logger = deps.logger;
  const metrics = deps.metrics ?? getIssueListFreshnessMetrics();
  const now = deps.now ?? Date.now;
  const readBack =
    deps.readBack ??
    (async (nonce: string) => {
      const rows = await issueService(db).list(
        ISSUE_LIST_FRESHNESS_CANARY_COMPANY_ID,
        { status: "in_progress" },
      );
      const row = rows.find(
        (candidate) => nonceFromTitle(candidate.title) === nonce,
      );
      return row ? { nonce } : null;
    });
  const readBackByAssignee =
    deps.readBackByAssignee ??
    (async (nonce: string, assigneeAgentId: string) => {
      const rows = await issueService(db).list(
        ISSUE_LIST_FRESHNESS_CANARY_COMPANY_ID,
        { assigneeAgentId },
      );
      const row = rows.find(
        (candidate) => nonceFromTitle(candidate.title) === nonce,
      );
      return row
        ? { title: row.title, assigneeAgentId: row.assigneeAgentId }
        : null;
    });
  const writeSentinel =
    deps.writeSentinel ??
    (async (title: string, at: Date, assigneeAgentId: string) => {
      await db
        .update(issues)
        .set({
          title,
          updatedAt: at,
          status: "in_progress",
          hiddenAt: null,
          assigneeAgentId,
        })
        .where(eq(issues.id, ISSUE_LIST_FRESHNESS_CANARY_ISSUE_ID));
      noteIssueListMutation(ISSUE_LIST_FRESHNESS_CANARY_COMPANY_ID); // NFM-5850 list-gating patch
    });

  let sentinelEnsured = false;
  let stuckWrite: StuckWrite | null = null;
  let lastAssignee: string | null = null;

  const ensureSentinelFn =
    deps.ensureSentinel ??
    (async () => {
      await db
        .insert(companies)
        .values({
          id: ISSUE_LIST_FRESHNESS_CANARY_COMPANY_ID,
          name: "issue-list-freshness-canary (internal sentinel — no user data)",
          issuePrefix: "CANARY",
          requireBoardApprovalForNewAgents: false,
        })
        .onConflictDoNothing();
      await db
        .insert(agents)
        .values([
          {
            id: ISSUE_LIST_FRESHNESS_CANARY_ASSIGNEE_A_ID,
            companyId: ISSUE_LIST_FRESHNESS_CANARY_COMPANY_ID,
            name: "issue-list-freshness-canary assignee A",
          },
          {
            id: ISSUE_LIST_FRESHNESS_CANARY_ASSIGNEE_B_ID,
            companyId: ISSUE_LIST_FRESHNESS_CANARY_COMPANY_ID,
            name: "issue-list-freshness-canary assignee B",
          },
        ])
        .onConflictDoNothing();
      await db
        .insert(issues)
        .values({
          id: ISSUE_LIST_FRESHNESS_CANARY_ISSUE_ID,
          companyId: ISSUE_LIST_FRESHNESS_CANARY_COMPANY_ID,
          title: sentinelTitle("seed"),
          status: "in_progress",
          priority: "low",
          updatedAt: new Date(now()),
        })
        .onConflictDoNothing();
    });

  const evaluateLegs = async (
    anchor: {
      nonce: string;
      assignee: string;
      prevAssignee: string | null;
    },
  ): Promise<IssueListFreshnessCanaryLeg | null> => {
    const seen = await readBack(anchor.nonce);
    if (!seen) return "existence";
    const fieldRow = await readBackByAssignee(anchor.nonce, anchor.assignee);
    if (!fieldRow || fieldRow.assigneeAgentId !== anchor.assignee) {
      return "field_new";
    }
    if (anchor.prevAssignee) {
      const staleRow = await readBackByAssignee(
        anchor.nonce,
        anchor.prevAssignee,
      );
      if (staleRow) return "field_old";
    }
    return null;
  };

  const warnOncePerStuckWrite = (
    anchor: StuckWrite,
    lagMs: number,
    leg: IssueListFreshnessCanaryLeg,
  ) => {
    if (anchor.warned || lagMs <= ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS) return;
    anchor.warned = true;
    metrics.breach();
    logger?.warn(
      {
        event: "issue_list_freshness_visibility_lag",
        lagMs,
        thresholdMs: ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS,
        nonce: anchor.nonce,
        leg,
      },
      "issues list freshness canary: list query lagged sentinel write",
    );
  };

  return {
    async ensureSentinel() {
      if (sentinelEnsured) return;
      await ensureSentinelFn();
      sentinelEnsured = true;
    },

    async tick(): Promise<IssueListFreshnessCanaryTickResult> {
      if (!sentinelEnsured) await this.ensureSentinel();

      if (!stuckWrite) {
        // Fresh sentinel write (assignee flips each tick), then same-tick
        // read-backs through the production list query shapes.
        const nonce = `${Date.now()}-${randomUUID()}`;
        const assignee =
          lastAssignee === ISSUE_LIST_FRESHNESS_CANARY_ASSIGNEE_A_ID
            ? ISSUE_LIST_FRESHNESS_CANARY_ASSIGNEE_B_ID
            : ISSUE_LIST_FRESHNESS_CANARY_ASSIGNEE_A_ID;
        const prevAssignee = lastAssignee;
        await writeSentinel(sentinelTitle(nonce), new Date(now()), assignee);
        const committedAt = now();
        const failedLeg = await evaluateLegs({ nonce, assignee, prevAssignee });
        if (!failedLeg) {
          lastAssignee = assignee;
          metrics.tick("fresh");
          return { outcome: "fresh", lagMs: now() - committedAt };
        }
        stuckWrite = {
          nonce,
          committedAt,
          warned: false,
          assignee,
          prevAssignee,
          lastFailedLeg: failedLeg,
        };
        metrics.tick("lagging");
        return { outcome: "lagging", leg: failedLeg, lagMs: now() - committedAt };
      }

      // A write is stuck: re-affirm the SAME nonce and assignee (fresh
      // updated_at → fresh index entries) and re-observe until every leg
      // passes.
      const anchor = stuckWrite;
      await writeSentinel(
        sentinelTitle(anchor.nonce),
        new Date(now()),
        anchor.assignee,
      );
      const failedLeg = await evaluateLegs(anchor);
      const lagMs = now() - anchor.committedAt;
      if (!failedLeg) {
        warnOncePerStuckWrite(anchor, lagMs, anchor.lastFailedLeg);
        if (lagMs > ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS) {
          logger?.info(
            {
              event: "issue_list_freshness_recovered",
              lagMs,
              nonce: anchor.nonce,
            },
            "issues list freshness canary recovered",
          );
        }
        lastAssignee = anchor.assignee;
        stuckWrite = null;
        metrics.tick("fresh");
        return { outcome: "fresh", lagMs };
      }
      warnOncePerStuckWrite(anchor, lagMs, failedLeg);
      anchor.lastFailedLeg = failedLeg;
      metrics.tick("lagging");
      return { outcome: "lagging", leg: failedLeg, lagMs };
    },
  };
}

export type IssueListFreshnessCanaryHandle = {
  stop(): void;
};

/**
 * Start the periodic canary. Returns null when disabled via env. The interval
 * is unref'd so the canary never keeps the process alive on its own.
 */
export function startIssueListFreshnessCanary(
  deps: Omit<
    IssueListFreshnessCanaryDeps,
    "now" | "readBack" | "readBackByAssignee" | "writeSentinel"
  > & {
    intervalMs?: number | null;
    env?: NodeJS.ProcessEnv;
    /** Optional gate evaluated before bootstrap and every tick (e.g. warm-standby skip). */
    shouldTick?: () => boolean;
  },
): IssueListFreshnessCanaryHandle | null {
  const intervalMs =
    deps.intervalMs !== undefined
      ? deps.intervalMs
      : resolveIssueListFreshnessCanaryIntervalMs(deps.env ?? process.env);
  if (intervalMs === null) return null;

  const core = createIssueListFreshnessCanaryCore(deps);
  const gate = () => !deps.shouldTick || deps.shouldTick();
  if (gate()) {
    core.ensureSentinel().catch((err) => {
      deps.logger?.error(
        { err },
        "issues list freshness canary sentinel bootstrap failed",
      );
    });
  }
  const timer = setInterval(() => {
    if (!gate()) return;
    core.tick().catch((err) => {
      deps.logger?.error({ err }, "issues list freshness canary tick failed");
    });
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

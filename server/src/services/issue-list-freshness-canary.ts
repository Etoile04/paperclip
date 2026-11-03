/**
 * In-server issues-list freshness canary (NFM-5843, AC2).
 *
 * Every tick (default 15s, charter bound ≤30s) the canary writes the sentinel
 * issue in a dedicated scratch company and reads it back through the SAME
 * list query shape the production list route uses
 * (`issueService(db).list(company, { status: "in_progress" })` — the
 * company/status-filtered shape served by `issues_company_status_idx`).
 *
 * Each sentinel write updates `updated_at` — an indexed column — so every
 * tick mints fresh btree entries in all `issues` secondary indexes, the exact
 * access paths that froze during the NFM-5838 incident.
 *
 * A sentinel write that stays invisible through the list query past
 * {@link ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS} emits a WARN log and
 * increments `paperclip_issue_list_freshness_visibility_lag_breaches_total`
 * exactly once per stuck write, then logs recovery once it becomes visible.
 * While a write is stuck, subsequent ticks re-affirm the SAME sentinel nonce
 * (fresh `updated_at`, fresh index entries) so the anchor stays observable.
 *
 * The sentinel lives in its own scratch company, so it can never appear in a
 * real company's list, search, or patrol reads (every list query is scoped by
 * `company_id`) — the canary writes no user-visible data.
 */

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { companies, issues, type Db } from "@paperclipai/db";
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

export type IssueListFreshnessCanaryLogger = {
  info(payload: unknown, message: string): void;
  warn(payload: unknown, message: string): void;
  error(payload: unknown, message: string): void;
};

export type IssueListFreshnessCanaryTickResult = {
  outcome: "fresh" | "lagging";
  lagMs: number;
};

export type IssueListFreshnessCanaryDeps = {
  db: Db;
  logger?: IssueListFreshnessCanaryLogger;
  metrics?: IssueListFreshnessMetrics;
  now?: () => number;
  readBack?: (nonce: string) => Promise<{ nonce: string } | null>;
  writeSentinel?: (title: string, at: Date) => Promise<void>;
  /** Overridable for unit tests that inject readBack/writeSentinel. */
  ensureSentinel?: () => Promise<void>;
};

type StuckWrite = {
  nonce: string;
  committedAt: number;
  warned: boolean;
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
  /** Ensure the scratch company + sentinel row exist (idempotent). */
  ensureSentinel(): Promise<void>;
  /** One canary beat: sentinel write, then read-back through the list shape. */
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
  const writeSentinel =
    deps.writeSentinel ??
    (async (title: string, at: Date) => {
      await db
        .update(issues)
        .set({ title, updatedAt: at, status: "in_progress", hiddenAt: null })
        .where(eq(issues.id, ISSUE_LIST_FRESHNESS_CANARY_ISSUE_ID));
    });

  let sentinelEnsured = false;
  let stuckWrite: StuckWrite | null = null;

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

  const warnOncePerStuckWrite = (anchor: StuckWrite, lagMs: number) => {
    if (anchor.warned || lagMs <= ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS) return;
    anchor.warned = true;
    metrics.breach();
    logger?.warn(
      {
        event: "issue_list_freshness_visibility_lag",
        lagMs,
        thresholdMs: ISSUE_LIST_FRESHNESS_LAG_THRESHOLD_MS,
        nonce: anchor.nonce,
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
        // Fresh sentinel write, then same-tick read-back through the
        // production list query shape.
        const nonce = `${Date.now()}-${randomUUID()}`;
        await writeSentinel(sentinelTitle(nonce), new Date(now()));
        const committedAt = now();
        const seen = await readBack(nonce);
        if (seen) {
          metrics.tick("fresh");
          return { outcome: "fresh", lagMs: now() - committedAt };
        }
        stuckWrite = { nonce, committedAt, warned: false };
        metrics.tick("lagging");
        return { outcome: "lagging", lagMs: now() - committedAt };
      }

      // A write is stuck: re-affirm the SAME nonce (fresh updated_at → fresh
      // index entries) and re-read until the list query sees it.
      const anchor = stuckWrite;
      await writeSentinel(sentinelTitle(anchor.nonce), new Date(now()));
      const seen = await readBack(anchor.nonce);
      const lagMs = now() - anchor.committedAt;
      if (seen) {
        warnOncePerStuckWrite(anchor, lagMs);
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
        stuckWrite = null;
        metrics.tick("fresh");
        return { outcome: "fresh", lagMs };
      }
      warnOncePerStuckWrite(anchor, lagMs);
      metrics.tick("lagging");
      return { outcome: "lagging", lagMs };
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
  deps: Omit<IssueListFreshnessCanaryDeps, "now" | "readBack" | "writeSentinel"> & {
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

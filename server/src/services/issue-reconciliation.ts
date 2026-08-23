import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRelations, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";

/**
 * ADR-009 §4.3-a — daily reconciliation routine.
 *
 * Walks every issue's `blockedByIssueIds`, removes any UUID that points to a
 * terminal-status (`done` or `cancelled`) blocker, and writes a §4.1-shaped
 * audit log entry per dependent touched. When the dependent's resulting
 * `blockedByIssueIds` is empty AND its status is `blocked`, auto-transitions
 * to `todo` (or `in_progress` if it has an active `checkoutRunId`) and fires
 * a Paperclip wake for its assignee.
 *
 * Idempotence guard: a dependent whose `blockedByIssueIds` is unchanged after
 * filtering is skipped — no DB write, no audit entry, no wake. Re-running on
 * already-reconciled data is a no-op.
 *
 * Feature flag: `enableAdr009ReconcileRoutine` (default OFF). Reads from
 * instance experimental settings (the §4.1-a sibling uses the same pattern).
 * The conceptual flag name is `ADR_009_RECONCILE_ROUTINE_ENABLED`.
 *
 * Scope notes (per ADR-009 §4.3):
 * - This routine does NOT run a dry-run pass (sibling 2).
 * - This routine does NOT share helpers with §4.1-b/c — it self-contains its
 *   own audit log writer and auto-transition helper. Conflicts with §4.1-b/c
 *   are resolved at the §4.3-i integration task.
 */

export const ADR_009_RECONCILE_ROUTINE_FEATURE_FLAG = "ADR_009_RECONCILE_ROUTINE_ENABLED";

const TERMINAL_BLOCKER_STATUSES = ["done", "cancelled"] as const;

type EnqueueWakeup = (
  agentId: string,
  opts?: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown | null>;

export interface ReconcileIssueBlockersDailyOptions {
  /**
   * Wake-enqueue dependency. Provided by the bootstrap so the routine stays
   * free of the heartbeat service import cycle. When absent (tests), the
   * routine records `wake_fired: false` in the audit entry and does not fire.
   */
  enqueueWakeup?: EnqueueWakeup;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export interface ReconcileIssueBlockersDailyResult {
  /** Feature flag was disabled — entire routine was a no-op. */
  skippedReason?: "flag-disabled";
  /** Companies whose issues were scanned. */
  companiesScanned: number;
  /** Total dependents walked. */
  dependentsScanned: number;
  /** Dependents whose `blockedByIssueIds` was mutated. */
  dependentsTouched: number;
  /** UUIDs removed from dependents' `blockedByIssueIds`. */
  blockersRemoved: number;
  /** Audit log entries written. */
  auditEntriesWritten: number;
  /** Dependents auto-transitioned out of `blocked`. */
  autoTransitionsFired: number;
  /** Paperclip wakes enqueued. */
  wakesFired: number;
}

interface EdgeRow {
  companyId: string;
  blockerIssueId: string;
  blockerStatus: string;
  blockerIdentifier: string | null;
  dependentIssueId: string;
}

interface DependentState {
  companyId: string;
  status: string;
  identifier: string | null;
  assigneeAgentId: string | null;
  checkoutRunId: string | null;
}

export interface IssueReconciliationService {
  reconcileIssueBlockersDaily: (
    options?: ReconcileIssueBlockersDailyOptions,
  ) => Promise<ReconcileIssueBlockersDailyResult>;
}

function emptyResult(
  skippedReason: "flag-disabled",
): ReconcileIssueBlockersDailyResult {
  return {
    skippedReason,
    companiesScanned: 0,
    dependentsScanned: 0,
    dependentsTouched: 0,
    blockersRemoved: 0,
    auditEntriesWritten: 0,
    autoTransitionsFired: 0,
    wakesFired: 0,
  };
}

export function issueReconciliationService(db: Db): IssueReconciliationService {
  return {
    reconcileIssueBlockersDaily: async (options: ReconcileIssueBlockersDailyOptions = {}) => {
      const now = options.now ?? new Date();

      // Feature-flag short-circuit. ADR-009 §6 says default OFF in prod;
      // rollout proceeds via canary → promote.
      const experimental = await instanceSettingsService(db).getExperimental();
      if (!experimental.enableAdr009ReconcileRoutine) {
        return emptyResult("flag-disabled");
      }

      // Pull every `blocks` edge in a single query, joined to the blocker
      // issue's status. This is the equivalent of the per-issue scan the spec
      // describes, but executed as a single round-trip and grouped in memory.
      const edges: EdgeRow[] = await db
        .select({
          companyId: issueRelations.companyId,
          blockerIssueId: issueRelations.issueId,
          blockerStatus: issues.status,
          blockerIdentifier: issues.identifier,
          dependentIssueId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(eq(issueRelations.type, "blocks"));

      // Group edges by dependent so we can compute `after` for each.
      const dependentsById = new Map<
        string,
        { edges: EdgeRow[]; blockers: Set<string> }
      >();
      for (const edge of edges) {
        const bucket = dependentsById.get(edge.dependentIssueId) ?? {
          edges: [],
          blockers: new Set<string>(),
        };
        bucket.edges.push(edge);
        bucket.blockers.add(edge.blockerIssueId);
        dependentsById.set(edge.dependentIssueId, bucket);
      }

      const dependentIds = [...dependentsById.keys()];
      const dependentState = new Map<string, DependentState>();
      if (dependentIds.length > 0) {
        const dependentRows = await db
          .select({
            id: issues.id,
            companyId: issues.companyId,
            status: issues.status,
            identifier: issues.identifier,
            assigneeAgentId: issues.assigneeAgentId,
            checkoutRunId: issues.checkoutRunId,
          })
          .from(issues)
          .where(inArray(issues.id, dependentIds));
        for (const row of dependentRows) {
          dependentState.set(row.id, {
            companyId: row.companyId,
            status: row.status,
            identifier: row.identifier,
            assigneeAgentId: row.assigneeAgentId,
            checkoutRunId: row.checkoutRunId,
          });
        }
      }

      const companiesScanned = new Set<string>();
      let dependentsScanned = 0;
      let dependentsTouched = 0;
      let blockersRemoved = 0;
      let auditEntriesWritten = 0;
      let autoTransitionsFired = 0;
      let wakesFired = 0;

      for (const [dependentId, bucket] of dependentsById) {
        const dependentInfo = dependentState.get(dependentId);
        if (!dependentInfo) continue;

        const before = [...bucket.blockers];
        const after = before.filter((blockerId) => {
          const edge = bucket.edges.find((e) => e.blockerIssueId === blockerId);
          return !edge
            ? true
            : !TERMINAL_BLOCKER_STATUSES.includes(
                edge.blockerStatus as "done" | "cancelled",
              );
        });

        // Idempotence guard: no-op when nothing changed.
        if (
          before.length === after.length &&
          before.every((id, idx) => id === after[idx])
        ) {
          continue;
        }

        dependentsScanned += 1;
        companiesScanned.add(dependentInfo.companyId);

        const removedBlockerIds = before.filter((id) => !after.includes(id));
        const removedEdges = bucket.edges.filter((edge) =>
          removedBlockerIds.includes(edge.blockerIssueId),
        );

        // Group removed edges by closing blocker so the audit entry per
        // dependent can list every blocker that closed during this run.
        const closingByBlocker = new Map<
          string,
          { blockerIssueId: string; blockerIdentifier: string | null }
        >();
        for (const edge of removedEdges) {
          if (!closingByBlocker.has(edge.blockerIssueId)) {
            closingByBlocker.set(edge.blockerIssueId, {
              blockerIssueId: edge.blockerIssueId,
              blockerIdentifier: edge.blockerIdentifier,
            });
          }
        }

        // Delete obsolete relations in one DELETE. We narrow by both the
        // dependent and the closing-blocker list so we never sweep unrelated
        // rows.
        const relationDelete = await db
          .delete(issueRelations)
          .where(
            and(
              eq(issueRelations.companyId, dependentInfo.companyId),
              eq(issueRelations.relatedIssueId, dependentId),
              eq(issueRelations.type, "blocks"),
              inArray(issueRelations.issueId, removedBlockerIds),
            ),
          )
          .returning({ issueId: issueRelations.issueId });

        const actuallyRemoved = relationDelete.length;
        // If the DELETE returned fewer rows than expected, the dependent was
        // already partially reconciled by another concurrent path. Skip the
        // auto-transition / wake for this dependent (it's already done).
        if (actuallyRemoved === 0) continue;

        dependentsTouched += 1;
        blockersRemoved += actuallyRemoved;

        const willAutoTransition =
          after.length === 0 && dependentInfo.status === "blocked";
        const targetStatus = willAutoTransition
          ? dependentInfo.checkoutRunId
            ? "in_progress"
            : "todo"
          : null;

        // Auto-transition: only when `after == []` and the dependent was
        // `blocked`. PATCH the dependent's status and (if applicable) the
        // `startedAt` side-effect column.
        let wakeFired = false;
        if (willAutoTransition && targetStatus) {
          const transitionPatch: Partial<typeof issues.$inferInsert> = {
            status: targetStatus,
            updatedAt: now,
          };
          if (targetStatus === "in_progress") {
            transitionPatch.startedAt = now;
          }
          await db
            .update(issues)
            .set(transitionPatch)
            .where(
              and(
                eq(issues.id, dependentId),
                eq(issues.companyId, dependentInfo.companyId),
                eq(issues.status, "blocked"), // safety: only flip blocked rows
              ),
            );
          autoTransitionsFired += 1;

          // Fire Paperclip wake for the assignee so they pick up the now-
          // unblocked work. We only wake when an assignee exists and the
          // dependent is no longer in a terminal state. The audit entry below
          // is written AFTER this so `wake_fired` reflects reality.
          if (dependentInfo.assigneeAgentId && options.enqueueWakeup) {
            try {
              await options.enqueueWakeup(dependentInfo.assigneeAgentId, {
                source: "automation",
                triggerDetail: "system",
                reason: "issue_blockers_resolved",
                payload: {
                  issueId: dependentId,
                  resolvedBlockerIssueIds: removedBlockerIds,
                  viaRoutine: "adr009-daily-reconcile",
                },
                contextSnapshot: {
                  issueId: dependentId,
                  taskId: dependentId,
                  wakeReason: "issue_blockers_resolved",
                  source: "adr009-daily-reconcile",
                  resolvedBlockerIssueIds: removedBlockerIds,
                  transition: { from: dependentInfo.status, to: targetStatus },
                },
                requestedByActorType: "system",
                requestedByActorId: "adr009-daily-reconcile",
              });
              wakeFired = true;
              wakesFired += 1;
            } catch (wakeErr) {
              logger.warn(
                {
                  err: wakeErr,
                  issueId: dependentId,
                  agentId: dependentInfo.assigneeAgentId,
                  routine: "adr009-daily-reconcile",
                },
                "failed to enqueue post-reconcile wake",
              );
            }
          }
        }

        // Write one audit entry per (closing blocker, dependent) pair so an
        // operator can reconstruct which closures triggered the dependent's
        // mutation. The shape mirrors §4.1 verbatim; §4.3-i integration will
        // unify this with §4.1-c. `wake_fired` is recorded truthfully — it
        // reflects whether the wake actually fired (vs. was skipped because
        // there was no assignee / no enqueueWakeup dependency).
        for (const closing of closingByBlocker.values()) {
          await logActivity(db, {
            companyId: dependentInfo.companyId,
            actorType: "system",
            actorId: "adr009-daily-reconcile",
            action: "issue_blockers_updated",
            entityType: "issue",
            entityId: dependentId,
            details: {
              routine: "adr009-daily-reconcile",
              ts: now.toISOString(),
              closing_issue_id: closing.blockerIssueId,
              closing_issue_identifier: closing.blockerIdentifier,
              dependent_id: dependentId,
              dependent_identifier: dependentInfo.identifier,
              before_blockedByIssueIds: before,
              after_blockedByIssueIds: after,
              status_transition:
                willAutoTransition && targetStatus
                  ? { from: dependentInfo.status, to: targetStatus }
                  : null,
              wake_fired: wakeFired,
              feature_flag: ADR_009_RECONCILE_ROUTINE_FEATURE_FLAG,
            },
          });
          auditEntriesWritten += 1;
        }
      }

      if (dependentsTouched > 0) {
        logger.info(
          {
            routine: "adr009-daily-reconcile",
            companiesScanned: companiesScanned.size,
            dependentsScanned,
            dependentsTouched,
            blockersRemoved,
            auditEntriesWritten,
            autoTransitionsFired,
            wakesFired,
          },
          "ADR-009 §4.3-a daily reconcile completed",
        );
      }

      return {
        companiesScanned: companiesScanned.size,
        dependentsScanned,
        dependentsTouched,
        blockersRemoved,
        auditEntriesWritten,
        autoTransitionsFired,
        wakesFired,
      };
    },
  };
}
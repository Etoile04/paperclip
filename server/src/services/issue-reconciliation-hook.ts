/**
 * ADR-009 §4.1-c (NFM-3571): Close-transition reverse-dependency
 * reconciliation hook — public contract for the §4.1 sweep.
 *
 * Sibling 1 (NFM-3569) wires the close-transition handler in
 * `server/src/services/issues.ts` so that any time an issue transitions
 * to a terminal state (`done` or `cancelled`), it calls
 * `applyCloseTransitionReconciliation(db, input)` AFTER the close has
 * been committed. The hook then sweeps every dependent whose
 * `blockedByIssueIds` referenced the closing issue, removes the closing
 * issue's UUID from the dependent's relations, and emits an audit row.
 *
 * Sibling 2 (NFM-3570) auto-transitions unblocked dependents and wakes
 * their assignees BEFORE invoking this hook. The hook itself does not
 * touch dependent status or fire wake requests — it only handles the
 * structural relation mutation and the audit trail.
 *
 * Rollout
 * --------
 * The hook is gated behind `adr009CloseTransitionReconciliationHookEnabled`
 * (instance experimental setting, default OFF in production). When OFF,
 * the function returns immediately with `skippedFlagOff: true` and
 * performs zero DB writes. This is the authoritative flag for §4.1 —
 * separate from `adr009ReconciliationHookEnabled` (§4.3's daily-cron
 * backstop) so the two rollouts can be sequenced.
 *
 * Atomicity
 * ---------
 * Each dependent's mutation (relation DELETE + audit INSERT) is wrapped
 * in `db.transaction(...)` so they commit together or not at all — the
 * C6.1 lesson from NFM-2868. If a per-dependent transaction fails (e.g.
 * the dependent row was concurrently deleted), the hook catches the
 * error, records the dependent in `failedDependents`, and continues
 * with the remaining dependents. The hook itself is therefore
 * retry-safe: a second invocation against a partially-successful sweep
 * finds no work to do (idempotence guard) and yields zero new audit rows.
 *
 * A dependent is treated as "successfully processed" only when its row
 * actually exists in `issues` for the input company AND its per-
 * dependent transaction commits. A non-existent dependent (the caller
 * passed an id whose row was deleted, or never seeded) is rejected up
 * front in `sweepDependent` — the exception is caught and the dependent
 * is recorded in `failedDependents` without emitting an audit row.
 * This prevents `dependentsProcessed` from overcounting phantom
 * reconciliations and restores the retry-safe invariant (AC-7).
 *
 * Idempotence
 * -----------
 * Each dependent is compared against the prior `beforeBlockers` and
 * `afterBlockers` set. If they are equal (or the closing-issue UUID is
 * already gone), the dependent is skipped without an audit row.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRelations, issues } from "@paperclipai/db";
import { instanceSettingsService } from "./instance-settings.js";
import { emitReconciliationAudit } from "./issue-reconciliation-audit.js";

export interface CloseTransitionReconciliationDependent {
  dependentId: string;
  dependentIdentifier: string;
  /** The dependent's `blockedByIssueIds` before this hook ran. */
  beforeBlockers: string[];
  /** The dependent's `blockedByIssueIds` after this hook will run. */
  afterBlockers: string[];
  /**
   * The status transition that the close-transition handler applied
   * (or will apply) on the dependent. `null` if no transition happened.
   * Captured for the audit row's `statusTransition` field.
   */
  statusTransition: { from: string; to: string } | null;
  /**
   * Whether the close-transition handler fired a wake for the
   * dependent's assignee (sibling B / NFM-3570's responsibility).
   * Captured for the audit row's `wakeFired` field.
   */
  wakeFired: boolean;
}

export interface CloseTransitionReconciliationInput {
  companyId: string;
  closingIssueId: string;
  closingIssueIdentifier: string;
  closingIssueStatus: string;
  /** AgentId of the actor who triggered the close transition (for audit). */
  agentId: string | null;
  /** Heartbeat run id of the actor who triggered the close transition (for audit). */
  runId: string | null;
  /** Dependents to reconcile. Computed by the §4.1 sibling-A sweep. */
  dependents: CloseTransitionReconciliationDependent[];
}

export interface CloseTransitionReconciliationFailedDependent {
  dependentId: string;
  dependentIdentifier: string;
  reason: string;
}

export interface CloseTransitionReconciliationResult {
  /**
   * True when the §4.1 flag is OFF — the hook short-circuited and
   * performed zero DB writes / zero audit emissions.
   */
  skippedFlagOff: boolean;
  /** Number of dependents successfully reconciled: the dependent row existed,
   * the closing-issue relation was removed, AND the audit row committed —
   * all inside one transaction. Phantom dependents (id not present in
   * `issues`) are NOT counted here; they appear in `failedDependents`. */
  dependentsProcessed: number;
  /** Number of `activity_log` rows emitted by this invocation. */
  auditRowsEmitted: number;
  /** Dependents whose per-dependent transaction failed; the sweep continued. */
  failedDependents: CloseTransitionReconciliationFailedDependent[];
}

/**
 * Apply the §4.1 close-transition reconciliation for one closing issue.
 *
 * Called by the close-transition handler in
 * `server/src/services/issues.ts` AFTER the closing issue's status has
 * been committed. The hook is retry-safe and idempotent: re-running on
 * an already-reconciled tree is a no-op (the `if before == after: continue`
 * guard inside `sweepDependent`).
 *
 * Per the §4.1 acceptance criteria:
 *   - Hook runs after `status -> done|cancelled` for every issue
 *     transition (caller's responsibility).
 *   - Sweep iterates `issue.blocks` (reverse dependents) and removes
 *     the closing issue's UUID from each dependent's
 *     `blockedByIssueIds` (this function).
 *   - Idempotent: re-running on an already-reconciled tree is a no-op
 *     (the `before == after` guard).
 *   - Transactional: each dependent's mutation commits atomically
 *     (`db.transaction` per dependent — see `sweepDependent`).
 *   - Audit log entry written for every dependent touched (this
 *     function calls `emitReconciliationAudit` inside the same tx).
 *   - Gated behind `adr009CloseTransitionReconciliationHookEnabled`
 *     (the §4.1 flag).
 */
export async function applyCloseTransitionReconciliation(
  db: Db,
  input: CloseTransitionReconciliationInput,
): Promise<CloseTransitionReconciliationResult> {
  const settings = await instanceSettingsService(db).getExperimental();
  if (!settings.adr009CloseTransitionReconciliationHookEnabled) {
    return {
      skippedFlagOff: true,
      dependentsProcessed: 0,
      auditRowsEmitted: 0,
      failedDependents: [],
    };
  }

  let dependentsProcessed = 0;
  let auditRowsEmitted = 0;
  const failedDependents: CloseTransitionReconciliationFailedDependent[] = [];

  for (const dep of input.dependents) {
    try {
      const outcome = await sweepDependent(db, input, dep);
      if (outcome === "processed") {
        dependentsProcessed += 1;
        auditRowsEmitted += 1;
      }
    } catch (err: unknown) {
      // Per-dependent failure does not abort the sweep. The C6.1 lesson
      // from NFM-2868: a partial reconciliation is better than no
      // reconciliation; the next invocation retries the failed
      // dependent via the `before == after` idempotence guard.
      failedDependents.push({
        dependentId: dep.dependentId,
        dependentIdentifier: dep.dependentIdentifier,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    skippedFlagOff: false,
    dependentsProcessed,
    auditRowsEmitted,
    failedDependents,
  };
}

type SweepOutcome = "processed" | "skipped-idempotent";

/**
 * Reconcile a single dependent: remove the closing-issue UUID from its
 * blocker relations and emit an audit row, both inside a single Drizzle
 * transaction.
 *
 * Returns `"skipped-idempotent"` when `before == after` (no work to do).
 * Returns `"processed"` when the relation DELETE and audit INSERT
 * committed atomically.
 */
async function sweepDependent(
  db: Db,
  input: CloseTransitionReconciliationInput,
  dep: CloseTransitionReconciliationDependent,
): Promise<SweepOutcome> {
  // Idempotence guard: if the caller says `before == after`, the
  // closing-issue UUID is already gone from the dependent's
  // `blockedByIssueIds` — nothing to do, no audit row.
  const sameSet =
    dep.beforeBlockers.length === dep.afterBlockers.length &&
    dep.beforeBlockers.every((id, idx) => id === dep.afterBlockers[idx]);
  if (sameSet) {
    return "skipped-idempotent";
  }

  // The closing-issue UUID is the only blocker we expect to have been
  // removed in the §4.1 sweep (the sibling-A logic ensures each
  // dependent's `afterBlockers = before - [closingIssueId]`).
  const closingIssueRemoved = !dep.afterBlockers.includes(input.closingIssueId);
  if (!closingIssueRemoved) {
    // Defensive: the caller passed an `afterBlockers` that still
    // contains the closing issue, so there's no work to do here.
    return "skipped-idempotent";
  }

  // Pre-flight existence check: the dependent row must exist in this
  // company. Without this, a stale caller (or one where the dependent
  // was concurrently deleted) would silently "succeed" — the relation
  // DELETE matches 0 rows and `activity_log.entityId` has no FK to
  // `issues`, so the audit row would be emitted for a non-existent
  // dependent and `dependentsProcessed` would overcount. Throw so the
  // outer try/catch records this dependent in `failedDependents` and
  // the sweep continues with the remaining dependents. The retry-safe
  // invariant is restored: a dependent only counts as processed when
  // its row was actually found and reconciled.
  const existingRows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.id, dep.dependentId),
        eq(issues.companyId, input.companyId),
      ),
    )
    .limit(1);
  if (existingRows.length === 0) {
    throw new Error(
      `dependent ${dep.dependentIdentifier} (${dep.dependentId}) not found in company ${input.companyId}`,
    );
  }

  // The blockers present in `before` but absent in `after` are what we
  // need to delete from `issueRelations`.
  const removedBlockers = dep.beforeBlockers.filter(
    (id) => !dep.afterBlockers.includes(id),
  );

  await db.transaction(async (tx) => {
    if (removedBlockers.length > 0) {
      await tx
        .delete(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, input.companyId),
            eq(issueRelations.relatedIssueId, dep.dependentId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.issueId, removedBlockers),
          ),
        );
    }

    await emitReconciliationAudit(tx, {
      companyId: input.companyId,
      agentId: input.agentId,
      runId: input.runId,
      closingIssue: {
        id: input.closingIssueId,
        identifier: input.closingIssueIdentifier,
        status: input.closingIssueStatus,
      },
      dependent: {
        id: dep.dependentId,
        identifier: dep.dependentIdentifier,
      },
      before: { blockedByIssueIds: dep.beforeBlockers },
      after: { blockedByIssueIds: dep.afterBlockers },
      statusTransition: dep.statusTransition,
      wakeFired: dep.wakeFired,
    });
  });

  return "processed";
}
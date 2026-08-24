/**
 * ADR-009 §4.3-c (NFM-3601): Audit log emitter for the daily 06:00 UTC
 * cancelled-blocker reconciliation routine.
 *
 * Reuses the existing `activity_log` table (no new migration). Each row is
 * an `actorType='system'`, `actorId='adr009-reconciliation'`, `action=
 * 'issue_blocker_reconciled'` event whose `details` JSONB carries the same
 * six fields from the ADR-009 §4.1 acceptance criteria:
 *
 *   - closingIssue      (id, identifier, status)
 *   - dependent         (id, identifier)
 *   - before            (blockedByIssueIds)
 *   - after             (blockedByIssueIds)
 *   - statusTransition  (from, to) | null
 *   - wakeFired         boolean
 *
 * §4.3 batch adaptation notes:
 *   - `closingIssue` is set to the first cleared blocker (or a batch
 *     marker when multiple blockers are cleared). The full list of
 *     cleared blockers is in `details.clearedBlockers`.
 *   - `wakeFired` is always `false` at write time because §4.3 defers
 *     wake emission to post-commit. The actual wake results are in the
 *     function return value, not in the audit row.
 *
 * Shape is byte-for-byte compatible with §4.1's audit entries
 * (NFM-3571 `issue-reconciliation-audit.ts`).
 */

import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
type ReconciliationDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface ReconciliationAuditEvent {
  companyId: string;
  agentId: string | null;
  runId: string | null;
  closingIssue: { id: string; identifier: string; status: string };
  dependent: { id: string; identifier: string };
  before: { blockedByIssueIds: string[] };
  after: { blockedByIssueIds: string[] };
  statusTransition: { from: string; to: string } | null;
  wakeFired: boolean;
  clearedBlockers?: Array<{ id: string; identifier: string; status: string }>;
}

export const RECONCILIATION_AUDIT_ACTION = "issue_blocker_reconciled";
export const RECONCILIATION_AUDIT_ACTOR_TYPE = "system" as const;
export const RECONCILIATION_AUDIT_ACTOR_ID = "adr009-reconciliation";
export const RECONCILIATION_AUDIT_ENTITY_TYPE = "issue";

/**
 * Write a single audit row for a dependent touched by the §4.3 daily sweep.
 *
 * Accepts either the root Drizzle `db` or a transaction handle so callers
 * can wrap the audit insert in the same transaction as the relation
 * removal (the C6.1 lesson from NFM-2868 — commit the data change and
 * the audit row together or not at all).
 */
export async function emitReconciliationAudit(
  dbOrTx: ReconciliationDb,
  event: ReconciliationAuditEvent,
): Promise<void> {
  await dbOrTx.insert(activityLog).values({
    companyId: event.companyId,
    actorType: RECONCILIATION_AUDIT_ACTOR_TYPE,
    actorId: RECONCILIATION_AUDIT_ACTOR_ID,
    action: RECONCILIATION_AUDIT_ACTION,
    entityType: RECONCILIATION_AUDIT_ENTITY_TYPE,
    entityId: event.dependent.id,
    agentId: event.agentId,
    runId: event.runId,
    details: {
      closingIssue: event.closingIssue,
      dependent: event.dependent,
      before: event.before,
      after: event.after,
      statusTransition: event.statusTransition,
      wakeFired: event.wakeFired,
      ...(event.clearedBlockers?.length
        ? { clearedBlockers: event.clearedBlockers }
        : {}),
    },
  });
}

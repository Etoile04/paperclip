/**
 * ADR-009 §4.1-c (NFM-3571): Audit log emitter for the close-transition
 * reverse-dependency reconciliation hook.
 *
 * Reuses the existing `activity_log` table (no new migration). Each row is
 * an `actorType='system'`, `actorId='adr009-reconciliation'`, `action=
 * 'issue_blocker_reconciled'` event whose `details` JSONB carries the six
 * required fields from the ADR-009 §4.1 acceptance criteria:
 *
 *   - closingIssue      (id, identifier, status)
 *   - dependent         (id, identifier)
 *   - before            (blockedByIssueIds)
 *   - after             (blockedByIssueIds)
 *   - statusTransition  (from, to) | null
 *   - wakeFired         boolean
 *
 * Plus the structural fields the activity_log table carries for every
 * entry: companyId, agentId, runId, createdAt.
 *
 * The emitter is itself feature-flagged at the call site
 * (`issue-reconciliation-hook.ts`): when the §4.1 flag is OFF, no
 * reconciliation runs and therefore no audit row is emitted. This file
 * does NOT gate itself — keeping the gate at the hook entry lets us
 * unit-test the emitter in isolation.
 */

import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";

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
}

export const RECONCILIATION_AUDIT_ACTION = "issue_blocker_reconciled";
export const RECONCILIATION_AUDIT_ACTOR_TYPE = "system" as const;
export const RECONCILIATION_AUDIT_ACTOR_ID = "adr009-reconciliation";
export const RECONCILIATION_AUDIT_ENTITY_TYPE = "issue";

/**
 * Write a single audit row for a dependent touched by the §4.1 sweep.
 *
 * Accepts either the root Drizzle `db` or a transaction handle so callers
 * can wrap the audit insert in the same transaction as the relation
 * removal (the C6.1 lesson from NFM-2868 — commit the data change and
 * the audit row together or not at all).
 */
export async function emitReconciliationAudit(
  dbOrTx: Db,
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
    },
  });
}
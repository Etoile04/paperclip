import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns } from "@paperclipai/db";
import { PLUGIN_EVENT_TYPES, type PluginEventType } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { publishLiveEvent } from "./live-events.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";
import { logger } from "../middleware/logger.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { instanceSettingsService } from "./instance-settings.js";

const PLUGIN_EVENT_SET: ReadonlySet<string> = new Set(PLUGIN_EVENT_TYPES);
const ACTIVITY_ACTION_TO_PLUGIN_EVENT: Readonly<Record<string, PluginEventType>> = {
  issue_comment_added: "issue.comment.created",
  issue_comment_created: "issue.comment.created",
  issue_document_created: "issue.document.created",
  issue_document_updated: "issue.document.updated",
  issue_document_deleted: "issue.document.deleted",
  issue_blockers_updated: "issue.relations.updated",
  approval_approved: "approval.decided",
  approval_rejected: "approval.decided",
  approval_revision_requested: "approval.decided",
  budget_soft_threshold_crossed: "budget.incident.opened",
  budget_hard_threshold_crossed: "budget.incident.opened",
  budget_incident_resolved: "budget.incident.resolved",
};

let _pluginEventBus: PluginEventBus | null = null;

/** Wire the plugin event bus so domain events are forwarded to plugins. */
export function setPluginEventBus(bus: PluginEventBus): void {
  if (_pluginEventBus) {
    logger.warn("setPluginEventBus called more than once, replacing existing bus");
  }
  _pluginEventBus = bus;
}

function eventTypeForActivityAction(action: string): PluginEventType | null {
  if (PLUGIN_EVENT_SET.has(action)) return action as PluginEventType;
  return ACTIVITY_ACTION_TO_PLUGIN_EVENT[action.replaceAll(".", "_")] ?? null;
}

export function publishPluginDomainEvent(event: PluginEvent): void {
  if (!_pluginEventBus) return;
  void _pluginEventBus.emit(event).then(({ errors }) => {
    for (const { pluginId, error } of errors) {
      logger.warn({ pluginId, eventType: event.eventType, err: error }, "plugin event handler failed");
    }
  }).catch(() => {});
}

export interface LogActivityInput {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  details?: Record<string, unknown> | null;
}

const ACTIVITY_LOG_RUN_ID_FK = "activity_log_run_id_heartbeat_runs_id_fk";

/**
 * True when `err` is a Postgres foreign-key violation on activity_log.run_id.
 * Drizzle may wrap the driver error in a `DrizzleQueryError`, so the original
 * error is also inspected via `cause`. The constraint field is spelled
 * `constraint` on node-pg errors and `constraint_name` on postgres.js errors;
 * both shapes are accepted.
 */
function isRunIdForeignKeyViolation(err: unknown): boolean {
  const candidates = [err, (err as { cause?: unknown } | null | undefined)?.cause];
  return candidates.some((candidate) => {
    const e = candidate as
      | { code?: string; constraint?: string; constraint_name?: string }
      | null
      | undefined;
    const constraint = e?.constraint ?? e?.constraint_name;
    return e?.code === "23503" && constraint === ACTIVITY_LOG_RUN_ID_FK;
  });
}

export async function logActivity(db: Db, input: LogActivityInput) {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const redactedDetails = sanitizedDetails
    ? redactCurrentUserValue(sanitizedDetails, currentUserRedactionOptions)
    : null;

  // NFM-4977 / ADR-019: `actor.runId` may originate from an unvalidated agent
  // JWT `run_id` claim or an `x-paperclip-run-id` header and reference no
  // heartbeat_runs row. Writing it would violate activity_log's run_id FK and
  // 500 an already-succeeded operation, so probe once and degrade to null
  // instead of rejecting the write.
  let runId = input.runId ?? null;
  if (runId) {
    const exists = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1)
      .then((rows) => rows.length > 0);
    if (!exists) {
      logger.warn(
        {
          runId,
          actorType: input.actorType,
          actorId: input.actorId,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
        },
        "activity log run id does not reference a heartbeat run; dropping run attribution",
      );
      runId = null;
    }
  }

  const values = {
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId,
    details: redactedDetails,
  };

  try {
    await db.insert(activityLog).values(values);
  } catch (err) {
    // Belt for the probe→insert race (run row deleted in between, e.g. by a
    // company/agent teardown cascade): retry once without run attribution.
    if (runId === null || !isRunIdForeignKeyViolation(err)) throw err;
    logger.warn(
      { err, runId, actorType: input.actorType, actorId: input.actorId, action: input.action },
      "activity log insert hit the run_id foreign key after the existence probe; retrying without run attribution",
    );
    await db.insert(activityLog).values({ ...values, runId: null });
  }

  publishLiveEvent({
    companyId: input.companyId,
    type: "activity.logged",
    payload: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: input.agentId ?? null,
      runId,
      details: redactedDetails,
    },
  });

  const pluginEventType = eventTypeForActivityAction(input.action);
  if (pluginEventType) {
    const event: PluginEvent = {
      eventId: randomUUID(),
      eventType: pluginEventType,
      occurredAt: new Date().toISOString(),
      actorId: input.actorId,
      actorType: input.actorType,
      entityId: input.entityId,
      entityType: input.entityType,
      companyId: input.companyId,
      payload: {
        ...redactedDetails,
        agentId: input.agentId ?? null,
        runId,
      },
    };
    publishPluginDomainEvent(event);
  }
}

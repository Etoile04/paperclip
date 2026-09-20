import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const HEARTBEAT_RUNS_FK_SUFFIX = "heartbeat_runs_id_fk";

export interface RunAttributionContext {
  /** Column about to be written, e.g. "issue_comments.created_by_run_id". */
  target: string;
  entityType?: string;
  entityId?: string;
  actorType?: string;
  actorId?: string;
}

/**
 * True when `err` is a Postgres foreign-key violation whose constraint
 * references heartbeat_runs (any `<table>_<column>_heartbeat_runs_id_fk`).
 * Drizzle may wrap the driver error in a `DrizzleQueryError`, so the original
 * error is also inspected via `cause`. The constraint field is spelled
 * `constraint` on node-pg errors and `constraint_name` on postgres.js errors;
 * both shapes are accepted.
 */
export function isHeartbeatRunForeignKeyViolation(err: unknown): boolean {
  const candidates = [err, (err as { cause?: unknown } | null | undefined)?.cause];
  return candidates.some((candidate) => {
    const e = candidate as
      | { code?: string; constraint?: string; constraint_name?: string }
      | null
      | undefined;
    const constraint = e?.constraint ?? e?.constraint_name;
    return e?.code === "23503" && typeof constraint === "string" && constraint.endsWith(HEARTBEAT_RUNS_FK_SUFFIX);
  });
}

/**
 * ADR-019 probe, extracted for reuse beyond activity_log (NFM-4982):
 * `actor.runId` may originate from an unvalidated agent JWT `run_id` claim or
 * an `x-paperclip-run-id` header and reference no heartbeat_runs row. Writing
 * it would violate the receiving table's run-id foreign key and 500 an
 * already-succeeded operation, so probe once on the same handle (base `Db`
 * or a transaction) and degrade to null instead of rejecting the write. A
 * null/undefined run id passes through unchanged — an unverifiable run costs
 * telemetry attribution, never availability.
 */
export async function resolveRunIdForWrite(
  db: Pick<Db, "select">,
  runId: string | null | undefined,
  context: RunAttributionContext,
): Promise<string | null> {
  if (!runId) return null;
  const exists = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .limit(1)
    .then((rows) => rows.length > 0);
  if (!exists) {
    logger.warn(
      { runId, ...context },
      "run id does not reference a heartbeat run; dropping run attribution",
    );
    return null;
  }
  return runId;
}

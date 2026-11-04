import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueThreadInteractions } from "@paperclipai/db";
import {
  CONNECTION_INTENT_SENTINEL_ADDRESSEE_USER_IDS,
  resolveConnectionIntentAddressee,
} from "./connection-intents.js";

export interface ConnectionIntentAddresseeMigrationOptions {
  /** Migrate a single company only; default is every company. */
  companyId?: string;
  /** Select and report without writing. */
  dryRun?: boolean;
  /**
   * Append one JSON line per migrated row (original addressee + payload) to
   * this file before writing. `null` opts out — the CLI defaults to a
   * timestamped file and only honors an explicit opt-out.
   */
  backupPath?: string | null;
}

export interface ConnectionIntentAddresseeMigrationChange {
  interactionId: string;
  companyId: string;
  issueId: string;
  from: string;
  to: string;
}

export interface ConnectionIntentAddresseeMigrationResult {
  scanned: number;
  migrated: number;
  /** Pending cards left alone because the company has no human member. */
  skippedNoHuman: number;
  /**
   * Pending cards left alone because their payload is missing or not a JSON
   * object. They are neither migrated, counted as changes, nor backed up
   * (NFM-5853); the counter keeps the report honest about what was scanned.
   */
  skippedCorruptPayload: number;
  changes: ConnectionIntentAddresseeMigrationChange[];
}

async function appendBackupLine(backupPath: string, row: {
  interactionId: string;
  companyId: string;
  issueId: string;
  previousAddresseeUserId: string;
  payload: unknown;
}) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(backupPath, `${JSON.stringify(row)}\n`, "utf8");
}

/**
 * Re-point pending connection-intent cards addressed to a synthetic principal
 * (e.g. `local-board`) at a real human company member (NFM-5852).
 *
 * Idempotent: migrated cards no longer carry a sentinel addressee, so a second
 * pass selects nothing. Resolved cards are never touched, and cards in
 * companies without human members stay on the sentinel addressee, matching the
 * creation-time fallback.
 */
export async function migrateLocalBoardConnectionIntentAddressees(
  db: Db,
  options: ConnectionIntentAddresseeMigrationOptions = {},
): Promise<ConnectionIntentAddresseeMigrationResult> {
  const { companyId, dryRun = false, backupPath = null } = options;
  const rows = await db
    .select()
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.kind, "connection_intent"),
      eq(issueThreadInteractions.status, "pending"),
      inArray(issueThreadInteractions.addresseeUserId, [...CONNECTION_INTENT_SENTINEL_ADDRESSEE_USER_IDS]),
      ...companyId ? [eq(issueThreadInteractions.companyId, companyId)] : [],
    ));

  const result: ConnectionIntentAddresseeMigrationResult = {
    scanned: rows.length,
    migrated: 0,
    skippedNoHuman: 0,
    skippedCorruptPayload: 0,
    changes: [],
  };

  for (const row of rows) {
    const from = row.addresseeUserId;
    if (!from) continue;
    // Narrow before accounting or backup (NFM-5853): a card whose payload is
    // missing or not an object cannot be migrated safely, so it must not be
    // reported as a change or written to the backup JSONL. The WHERE clause
    // pins kind to connection_intent; the payload shape itself cannot be
    // pinned by SQL, so it is discriminated here instead of after the write
    // prep, keeping the report, the backup, and the writes in lockstep.
    const payload = row.payload;
    if (row.kind !== "connection_intent" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      result.skippedCorruptPayload += 1;
      continue;
    }
    const to = await resolveConnectionIntentAddressee(db, row.companyId, from);
    if (to === from) {
      result.skippedNoHuman += 1;
      continue;
    }
    result.changes.push({
      interactionId: row.id,
      companyId: row.companyId,
      issueId: row.issueId,
      from,
      to,
    });
    if (dryRun) continue;

    if (backupPath) {
      await appendBackupLine(backupPath, {
        interactionId: row.id,
        companyId: row.companyId,
        issueId: row.issueId,
        previousAddresseeUserId: from,
        payload,
      });
    }

    await db
      .update(issueThreadInteractions)
      .set({
        addresseeUserId: to,
        payload: {
          ...payload,
          ...("routedFromUserId" in payload ? {} : { routedFromUserId: from }),
        },
        updatedAt: new Date(),
      })
      .where(eq(issueThreadInteractions.id, row.id));
    result.migrated += 1;
  }

  result.changes.sort((a, b) => a.interactionId.localeCompare(b.interactionId));
  return result;
}

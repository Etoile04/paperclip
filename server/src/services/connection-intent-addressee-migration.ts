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
    changes: [],
  };

  for (const row of rows) {
    const from = row.addresseeUserId;
    if (!from) continue;
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
        payload: row.payload,
      });
    }

    const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? row.payload as Record<string, unknown>
      : {};
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

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueThreadInteractions } from "@paperclipai/db";
import { connectionIntentPayloadSchema } from "@paperclipai/shared";
import {
  SYNTHETIC_CONNECTION_INTENT_ADDRESSEE_USER_IDS,
  resolveConnectionIntentAddressee,
} from "./connection-intent-addressee.js";

export interface PendingSyntheticAddressedIntent {
  id: string;
  companyId: string;
  issueId: string;
  addresseeUserId: string | null;
  payload: unknown;
}

/** Pending connection_intent cards whose addressee can never act on them. */
export async function listPendingSyntheticAddressedIntents(
  db: Db,
  companyId?: string,
): Promise<PendingSyntheticAddressedIntent[]> {
  const rows = await db
    .select({
      id: issueThreadInteractions.id,
      companyId: issueThreadInteractions.companyId,
      issueId: issueThreadInteractions.issueId,
      addresseeUserId: issueThreadInteractions.addresseeUserId,
      payload: issueThreadInteractions.payload,
    })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.kind, "connection_intent"),
        eq(issueThreadInteractions.status, "pending"),
        inArray(issueThreadInteractions.addresseeUserId, [...SYNTHETIC_CONNECTION_INTENT_ADDRESSEE_USER_IDS]),
      ),
    );
  return companyId ? rows.filter((row) => row.companyId === companyId) : rows;
}

export async function countPendingSyntheticAddressedIntents(db: Db): Promise<number> {
  return (await listPendingSyntheticAddressedIntents(db)).length;
}

export type ConnectionIntentAddresseeMigrationOutcome =
  | { action: "migrated"; from: string; to: string }
  | { action: "already-migrated"; from: string }
  | { action: "fallback"; from: string; reason: "no-human-member" };

/**
 * Re-address one pending card to the company's deterministic human operator,
 * mirroring what `resolveConnectionIntentAddressee` does at creation time.
 * Idempotent: cards already carrying `routedFromUserId` are left untouched,
 * and companies with no eligible human keep their original addressee.
 */
export async function migrateConnectionIntentAddressee(
  db: Db,
  row: PendingSyntheticAddressedIntent,
): Promise<ConnectionIntentAddresseeMigrationOutcome> {
  const from = row.addresseeUserId!;
  const existingRoutedFrom = (row.payload as { routedFromUserId?: string } | null)?.routedFromUserId;
  if (existingRoutedFrom) {
    return { action: "already-migrated", from };
  }
  const resolved = await resolveConnectionIntentAddressee(db, row.companyId, from);
  if (!resolved.routedFromUserId) {
    return { action: "fallback", from, reason: "no-human-member" };
  }
  // Validate before and after: the stored payload must stay schema-clean.
  const payload = connectionIntentPayloadSchema.parse({
    ...(row.payload as Record<string, unknown>),
    routedFromUserId: resolved.routedFromUserId,
  });
  await db
    .update(issueThreadInteractions)
    .set({ addresseeUserId: resolved.addresseeUserId, payload, updatedAt: new Date() })
    .where(eq(issueThreadInteractions.id, row.id));
  return { action: "migrated", from, to: resolved.addresseeUserId };
}

import { and, asc, eq, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companyMemberships } from "@paperclipai/db";

/**
 * Synthetic principals that can hold `runs.responsible_user_id` but can never
 * act on a connection intent. They have no login session, so the strict
 * `addressedIntent()` check 403s every real user while the card renders as
 * "Waiting for …" forever — the NFM-5851 addressee black hole.
 */
export const SYNTHETIC_CONNECTION_INTENT_ADDRESSEE_USER_IDS: ReadonlySet<string> = new Set([
  "local-board",
]);

export function isSyntheticConnectionIntentAddressee(userId: string | null | undefined): boolean {
  return typeof userId === "string" && SYNTHETIC_CONNECTION_INTENT_ADDRESSEE_USER_IDS.has(userId);
}

export interface ResolvedConnectionIntentAddressee {
  addresseeUserId: string;
  /** Set only when the responsible user was redirected to a human operator. */
  routedFromUserId: string | null;
}

/**
 * Human-first addressee resolution for connection intents (NFM-5851 ruling A).
 *
 * A connection intent asks one person to authorize a platform credential, and
 * every downstream consumer of `addresseeUserId` (setup options →
 * `resolveService`, the channel-purpose email-credential lookup) assumes that
 * person can log in. When the run's responsible user is a synthetic principal
 * (`local-board` …), the card is re-addressed to the company's
 * earliest-joined active human member so the request stays actionable.
 *
 * "Human" here means a real `user` row with an active company membership — the
 * same addressable-membership definition `agent-instruction-authorization`
 * uses. Login artifacts are deliberately not required: cloud-tenant users
 * authenticate through assertions and carry no local `account` row, so an
 * account join would wrongly exclude real operators.
 *
 * Creation never fails: with no eligible human the original value is returned
 * unchanged. Resolution is deterministic (earliest membership join, ids break
 * timestamp ties) so retries produce the same addressee — the creation
 * idempotency path 409s when a retried request names a different addressee.
 */
export async function resolveConnectionIntentAddressee(
  db: Db,
  companyId: string,
  responsibleUserId: string,
): Promise<ResolvedConnectionIntentAddressee> {
  if (!isSyntheticConnectionIntentAddressee(responsibleUserId)) {
    return { addresseeUserId: responsibleUserId, routedFromUserId: null };
  }
  const [candidate] = await db
    .select({ id: authUsers.id })
    .from(companyMemberships)
    .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active"),
      notInArray(authUsers.id, [...SYNTHETIC_CONNECTION_INTENT_ADDRESSEE_USER_IDS]),
    ))
    .orderBy(asc(companyMemberships.createdAt), asc(authUsers.id))
    .limit(1);
  if (!candidate) {
    return { addresseeUserId: responsibleUserId, routedFromUserId: null };
  }
  return { addresseeUserId: candidate.id, routedFromUserId: responsibleUserId };
}

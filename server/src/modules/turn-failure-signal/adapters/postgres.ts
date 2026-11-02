// NFM-5774 — postgres adapter for the turn-failure degradation signal.
// Reads live `claude_local` run outcomes for the rolling window and persists
// degradation episodes into the shared `auth_recovery_episodes` table under
// `kind = 'degradation'` (the auth lane filters it out — see the auth
// adapter's getActiveEpisode).

import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, authRecoveryEpisodes, heartbeatRuns } from "@paperclipai/db";

import type { TurnFailureWindowStats } from "../domain/signal-policy.js";
import type {
  DegradationCloseSource,
  DegradationEpisodeRow,
  TurnFailureSignalStore,
} from "../application/ports.js";

// Mirrors isAiAuthenticationFailure (server/src/services/ai-auth-failure.ts):
// provider-auth signals only. Kept in SQL so the whole window aggregates in
// one pass over `heartbeat_runs`.
const AUTH_FAILURE_SQL = sql`(
  ${heartbeatRuns.errorCode} ~ '^(acpx|claude|codex|grok|opencode|gemini|kimi|pi|cursor)_auth_required$'
  OR ${heartbeatRuns.errorCode} IN (
    'adapter_auth_missing',
    'authentication_required',
    'auth_required',
    'refresh_token_reused',
    'refresh_token_expired',
    'refresh_token_invalidated'
  )
)`;

/** Attributable turn outcomes: completed turns only. `cancelled` is an
 * operator/infra stop (stand-down semantics), never a turn outcome. */
const OUTCOME_STATUSES_SQL = sql`(${heartbeatRuns.status} IN ('succeeded', 'failed', 'timed_out'))`;
const FAILURE_STATUSES_SQL = sql`(${heartbeatRuns.status} IN ('failed', 'timed_out'))`;

function degradationRowFrom(raw: typeof authRecoveryEpisodes.$inferSelect): DegradationEpisodeRow {
  return {
    id: raw.id,
    companyId: raw.companyId,
    state: raw.state === "closed" ? "closed" : "red",
    startedAt: raw.startedAt.toISOString(),
    lastRestatedAt: raw.lastRestatedAt ? raw.lastRestatedAt.toISOString() : null,
  };
}

export function createPostgresTurnFailureSignalStore(db: Db): TurnFailureSignalStore {
  return {
    async countClaudeLocalOutcomes(companyId, input) {
      const [row] = await db
        .select({
          outcomes: sql<number>`count(*) filter (where ${OUTCOME_STATUSES_SQL})`.mapWith(Number),
          authFailures: sql<number>`count(*) filter (where ${FAILURE_STATUSES_SQL} AND ${AUTH_FAILURE_SQL})`.mapWith(Number),
          // `error_code` is nullable: NOT (NULL) is NULL and FILTER drops the
          // row, so unclassified failures need the explicit IS NULL arm to
          // land here (doc: "any other (or no) error code").
          otherFailures: sql<number>`count(*) filter (where ${FAILURE_STATUSES_SQL} AND (${heartbeatRuns.errorCode} IS NULL OR NOT ${AUTH_FAILURE_SQL}))`.mapWith(Number),
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(agents.adapterType, "claude_local"),
            gte(heartbeatRuns.finishedAt, new Date(input.windowStart)),
            lt(heartbeatRuns.finishedAt, new Date(input.windowEnd)),
          ),
        );
      return {
        outcomes: row?.outcomes ?? 0,
        authFailures: row?.authFailures ?? 0,
        otherFailures: row?.otherFailures ?? 0,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
      } satisfies TurnFailureWindowStats;
    },

    async getActiveDegradationEpisode(companyId) {
      const rows = await db
        .select()
        .from(authRecoveryEpisodes)
        .where(
          and(
            eq(authRecoveryEpisodes.companyId, companyId),
            eq(authRecoveryEpisodes.kind, "degradation"),
            sql`${authRecoveryEpisodes.state} <> 'closed'`,
          ),
        )
        .orderBy(desc(authRecoveryEpisodes.startedAt))
        .limit(1);
      return rows[0] ? degradationRowFrom(rows[0]) : null;
    },

    async insertDegradationEpisode(companyId, input) {
      const [row] = await db
        .insert(authRecoveryEpisodes)
        .values({
          companyId,
          state: "red",
          kind: "degradation",
          startedAt: new Date(input.startedAt),
        })
        .returning();
      return degradationRowFrom(row!);
    },

    async markDegradationRestated(episodeId, input) {
      await db
        .update(authRecoveryEpisodes)
        .set({ lastRestatedAt: new Date(input.restatedAt), updatedAt: new Date() })
        .where(eq(authRecoveryEpisodes.id, episodeId));
    },

    async closeDegradationEpisode(episodeId, input: { closedAt: string; source: DegradationCloseSource }) {
      // firstGreenAt/greenSource double as the resolution evidence for a
      // degradation episode: 'normalized' records when the window recovered;
      // 'canary-red' hands the incident to the auth machinery with no green.
      await db
        .update(authRecoveryEpisodes)
        .set({
          state: "closed",
          closedAt: new Date(input.closedAt),
          ...(input.source === "normalized"
            ? { firstGreenAt: new Date(input.closedAt), greenSource: input.source }
            : { greenSource: input.source }),
          updatedAt: new Date(),
        })
        .where(eq(authRecoveryEpisodes.id, episodeId));
    },
  };
}

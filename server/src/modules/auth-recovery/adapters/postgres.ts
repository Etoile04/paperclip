import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  authRecoveryEpisodeAgents,
  authRecoveryEpisodes,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  AUTH_RECOVERY_ERROR_CODE,
  type EnrollmentState,
  type EpisodeState,
} from "../domain/policy.js";
import type {
  AuthRecoveryEnrollmentRow,
  AuthRecoveryEpisodeRow,
  AuthRecoveryStore,
} from "../application/ports.js";

function episodeRowFrom(raw: typeof authRecoveryEpisodes.$inferSelect): AuthRecoveryEpisodeRow {
  return {
    id: raw.id,
    companyId: raw.companyId,
    state: raw.state as EpisodeState,
    startedAt: raw.startedAt.toISOString(),
    firstGreenAt: raw.firstGreenAt ? raw.firstGreenAt.toISOString() : null,
    firstGreenRunId: raw.firstGreenRunId,
    greenSource: raw.greenSource,
    wakesUsed: raw.wakesUsed,
    reenqueuedCount: raw.reenqueuedCount,
    manualCount: raw.manualCount,
  };
}

function enrollmentRowFrom(
  raw: typeof authRecoveryEpisodeAgents.$inferSelect,
): AuthRecoveryEnrollmentRow {
  return {
    episodeId: raw.episodeId,
    agentId: raw.agentId,
    state: raw.state as EnrollmentState,
    attempts: raw.attempts,
    firstLatchedAt: raw.firstLatchedAt.toISOString(),
    firstLatchedRunId: raw.firstLatchedRunId,
    lastWakeAt: raw.lastWakeAt ? raw.lastWakeAt.toISOString() : null,
    nextAttemptAt: raw.nextAttemptAt ? raw.nextAttemptAt.toISOString() : null,
    resolvedAt: raw.resolvedAt ? raw.resolvedAt.toISOString() : null,
  };
}

export function createPostgresAuthRecoveryStore(db: Db): AuthRecoveryStore {
  return {
    async getActiveEpisode(companyId) {
      const rows = await db
        .select()
        .from(authRecoveryEpisodes)
        .where(
          and(
            eq(authRecoveryEpisodes.companyId, companyId),
            // NFM-5774: the auth lane never sees degradation-class episodes
            // sharing this table.
            eq(authRecoveryEpisodes.kind, "auth"),
            sql`${authRecoveryEpisodes.state} <> 'closed'`,
          ),
        )
        .orderBy(desc(authRecoveryEpisodes.startedAt))
        .limit(1);
      return rows[0] ? episodeRowFrom(rows[0]) : null;
    },

    async insertEpisode(companyId, input) {
      const [row] = await db
        .insert(authRecoveryEpisodes)
        .values({ companyId, state: "red", kind: "auth", startedAt: new Date(input.startedAt) })
        .returning();
      return episodeRowFrom(row!);
    },

    async markEpisodeRecovering(episodeId, input) {
      await db
        .update(authRecoveryEpisodes)
        .set({
          state: "recovering",
          firstGreenAt: new Date(input.greenAt),
          firstGreenRunId: input.greenRunId,
          greenSource: input.greenSource,
          updatedAt: new Date(),
        })
        .where(eq(authRecoveryEpisodes.id, episodeId));
    },

    async markEpisodeRed(episodeId) {
      await db
        .update(authRecoveryEpisodes)
        .set({ state: "red", updatedAt: new Date() })
        .where(eq(authRecoveryEpisodes.id, episodeId));
    },

    async markEpisodeClosed(episodeId, closedAt) {
      await db
        .update(authRecoveryEpisodes)
        .set({ state: "closed", closedAt: new Date(closedAt), updatedAt: new Date() })
        .where(eq(authRecoveryEpisodes.id, episodeId));
    },

    async addEpisodeWakes(episodeId, count) {
      await db
        .update(authRecoveryEpisodes)
        .set({
          wakesUsed: sql`${authRecoveryEpisodes.wakesUsed} + ${count}`,
          updatedAt: new Date(),
        })
        .where(eq(authRecoveryEpisodes.id, episodeId));
    },

    async setEpisodeCounts(episodeId, input) {
      await db
        .update(authRecoveryEpisodes)
        .set({
          reenqueuedCount: input.reenqueuedCount,
          manualCount: input.manualCount,
          updatedAt: new Date(),
        })
        .where(eq(authRecoveryEpisodes.id, episodeId));
    },

    async listLatchEvidence(companyId, since) {
      const rows = await db
        .select({
          agentId: heartbeatRuns.agentId,
          firstLatchedAt: sql<string>`min(${heartbeatRuns.finishedAt})`,
          firstLatchedRunId: sql<string | null>`(array_agg(${heartbeatRuns.id} order by ${heartbeatRuns.finishedAt} asc))[1]`,
          agentStatus: agents.status,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.status, "failed"),
            eq(heartbeatRuns.errorCode, AUTH_RECOVERY_ERROR_CODE),
            gte(heartbeatRuns.finishedAt, new Date(since)),
          ),
        )
        .groupBy(heartbeatRuns.agentId, agents.status)
        .orderBy(asc(sql`min(${heartbeatRuns.finishedAt})`));
      return rows.map((row) => ({
        agentId: row.agentId,
        firstLatchedAt: new Date(row.firstLatchedAt).toISOString(),
        firstLatchedRunId: row.firstLatchedRunId,
        // An agent that left `error` by any path is no longer latched.
        isStillLatched: row.agentStatus === "error",
      }));
    },

    async listAgentsSucceededSince(companyId, since) {
      const rows = await db
        .selectDistinct({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.status, "succeeded"),
            gte(heartbeatRuns.finishedAt, new Date(since)),
          ),
        );
      return rows.map((row) => row.agentId);
    },

    async agentHasSuccessSince(companyId, agentId, since) {
      const rows = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "succeeded"),
            gte(heartbeatRuns.finishedAt, new Date(since)),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async isAgentStillLatched(companyId, agentId) {
      const rows = await db
        .select({ status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .limit(1);
      return rows[0]?.status === "error";
    },

    async upsertEnrollments(episodeId, companyId, rows) {
      if (rows.length === 0) return;
      await db
        .insert(authRecoveryEpisodeAgents)
        .values(
          rows.map((row) => ({
            episodeId,
            companyId,
            agentId: row.agentId,
            state: row.state,
            firstLatchedAt: new Date(row.firstLatchedAt),
            firstLatchedRunId: row.firstLatchedRunId,
          })),
        )
        .onConflictDoUpdate({
          target: [authRecoveryEpisodeAgents.episodeId, authRecoveryEpisodeAgents.agentId],
          set: {
            state: sql`excluded.state`,
            updatedAt: new Date(),
          },
        });
    },

    async listEnrollments(episodeId) {
      const rows = await db
        .select()
        .from(authRecoveryEpisodeAgents)
        .where(eq(authRecoveryEpisodeAgents.episodeId, episodeId))
        .orderBy(asc(authRecoveryEpisodeAgents.firstLatchedAt), asc(authRecoveryEpisodeAgents.agentId));
      return rows.map(enrollmentRowFrom);
    },

    async claimRetry(episodeId, agentId, expectedAttempts, input) {
      const rows = await db
        .update(authRecoveryEpisodeAgents)
        .set({
          attempts: sql`${authRecoveryEpisodeAgents.attempts} + 1`,
          lastWakeAt: new Date(input.lastWakeAt),
          nextAttemptAt: new Date(input.nextAttemptAt),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(authRecoveryEpisodeAgents.episodeId, episodeId),
            eq(authRecoveryEpisodeAgents.agentId, agentId),
            eq(authRecoveryEpisodeAgents.attempts, expectedAttempts),
          ),
        )
        .returning({ id: authRecoveryEpisodeAgents.id });
      return rows.length > 0;
    },

    async markEnrollment(episodeId, agentId, state, input) {
      await db
        .update(authRecoveryEpisodeAgents)
        .set({
          state,
          resolvedAt: input?.resolvedAt ? new Date(input.resolvedAt) : null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(authRecoveryEpisodeAgents.episodeId, episodeId),
            eq(authRecoveryEpisodeAgents.agentId, agentId),
          ),
        );
    },

    async setAgentErrorReason(agentId, reason) {
      // Guard on `error`: a latched agent that left error by another path
      // must not have its (already cleared or replaced) reason clobbered.
      await db
        .update(agents)
        .set({ errorReason: reason, updatedAt: new Date() })
        .where(and(eq(agents.id, agentId), eq(agents.status, "error")));
    },
  };
}

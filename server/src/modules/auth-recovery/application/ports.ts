import type { EnrollmentState, EpisodeState } from "../domain/policy.js";

/** One row of `auth_recovery_episodes`. */
export type AuthRecoveryEpisodeRow = {
  id: string;
  companyId: string;
  state: EpisodeState;
  startedAt: string;
  firstGreenAt: string | null;
  firstGreenRunId: string | null;
  greenSource: string | null;
  /** Total wakes this episode has fired (initial re-enqueues + retries). */
  wakesUsed: number;
  reenqueuedCount: number;
  manualCount: number;
};

/** One row of `auth_recovery_episode_agents`. */
export type AuthRecoveryEnrollmentRow = {
  episodeId: string;
  agentId: string;
  state: EnrollmentState;
  attempts: number;
  firstLatchedAt: string;
  firstLatchedRunId: string | null;
  lastWakeAt: string | null;
  nextAttemptAt: string | null;
  resolvedAt: string | null;
};

/**
 * Durable state the orchestration needs. The postgres adapter maps these
 * onto the two auth-recovery tables plus `heartbeat_runs`/`agents` reads.
 */
export type AuthRecoveryStore = {
  getActiveEpisode(companyId: string): Promise<AuthRecoveryEpisodeRow | null>;
  insertEpisode(companyId: string, input: { startedAt: string }): Promise<AuthRecoveryEpisodeRow>;
  markEpisodeRecovering(
    episodeId: string,
    input: { greenAt: string; greenRunId: string | null; greenSource: string },
  ): Promise<void>;
  markEpisodeRed(episodeId: string): Promise<void>;
  markEpisodeClosed(episodeId: string, closedAt: string): Promise<void>;
  addEpisodeWakes(episodeId: string, count: number): Promise<void>;
  setEpisodeCounts(episodeId: string, input: { reenqueuedCount: number; manualCount: number }): Promise<void>;
  /** Grouped latch evidence since the episode started (duplicate runs collapse to one entry per agent). */
  listLatchEvidence(
    companyId: string,
    since: string,
  ): Promise<Array<{ agentId: string; firstLatchedAt: string; firstLatchedRunId: string | null; isStillLatched: boolean }>>;
  listAgentsSucceededSince(companyId: string, since: string): Promise<string[]>;
  agentHasSuccessSince(companyId: string, agentId: string, since: string): Promise<boolean>;
  isAgentStillLatched(companyId: string, agentId: string): Promise<boolean>;
  upsertEnrollments(
    episodeId: string,
    companyId: string,
    rows: Array<{ agentId: string; firstLatchedAt: string; firstLatchedRunId: string | null; state: EnrollmentState }>,
  ): Promise<void>;
  listEnrollments(episodeId: string): Promise<AuthRecoveryEnrollmentRow[]>;
  /** Atomic attempt claim: succeeds only when `attempts` still equals `expectedAttempts`. */
  claimRetry(
    episodeId: string,
    agentId: string,
    expectedAttempts: number,
    input: { lastWakeAt: string; nextAttemptAt: string },
  ): Promise<boolean>;
  markEnrollment(
    episodeId: string,
    agentId: string,
    state: EnrollmentState,
    input?: { resolvedAt?: string },
  ): Promise<void>;
  setAgentErrorReason(agentId: string, reason: string): Promise<void>;
};

/** The wake primitive, injected by the heartbeat wiring (enqueueWakeup). */
export type AuthRecoveryWakeEnqueuer = {
  enqueueAuthRecoveryWake(input: {
    agentId: string;
    episodeId: string;
    attempt: number;
    idempotencyKey: string;
  }): Promise<unknown>;
};

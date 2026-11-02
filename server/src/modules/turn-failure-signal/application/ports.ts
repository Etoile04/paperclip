// NFM-5774 — durable state for the turn-failure degradation signal.
// Degradation episodes live in the SAME `auth_recovery_episodes` table as the
// auth machinery (post-PR-#39), discriminated by the `kind` column so both
// flows stay isolated: the auth lane only ever sees `kind = 'auth'` rows and
// this lane only ever sees `kind = 'degradation'` rows.

import type { TurnFailureWindowStats } from "../domain/signal-policy.js";

export type DegradationEpisodeRow = {
  id: string;
  companyId: string;
  state: "red" | "closed";
  startedAt: string;
  lastRestatedAt: string | null;
};

/** Why a degradation episode closed; recorded on the episode's greenSource. */
export type DegradationCloseSource = "normalized" | "canary-red";

export type TurnFailureSignalStore = {
  countClaudeLocalOutcomes(
    companyId: string,
    input: { windowStart: string; windowEnd: string },
  ): Promise<TurnFailureWindowStats>;
  getActiveDegradationEpisode(companyId: string): Promise<DegradationEpisodeRow | null>;
  insertDegradationEpisode(
    companyId: string,
    input: { startedAt: string },
  ): Promise<DegradationEpisodeRow>;
  markDegradationRestated(episodeId: string, input: { restatedAt: string }): Promise<void>;
  closeDegradationEpisode(
    episodeId: string,
    input: { closedAt: string; source: DegradationCloseSource },
  ): Promise<void>;
};

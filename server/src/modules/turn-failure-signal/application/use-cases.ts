// NFM-5774 — turn-failure-rate passive signal orchestration.
// Evaluated per company on the heartbeat scheduler tick: count the rolling
// window, read the canary, and drive the degradation episode through the
// post-PR-#39 episode machinery. Emissions are the episode row transitions
// plus structured logs — no new alert channel, no paging path (ADR-026 §5:
// R1 paging discipline unchanged, restate ≤1/h while red).
//
// NON-GOAL (ADR-026 §5 option 3, ratified deferral): no concurrency-class
// probe here. Adoption trigger = one confirmed canary-blind degradation this
// signal misses (>10 min undetected).

import {
  decideDegradationHold,
  decideDegradationOpen,
  turnFailureRate,
  type CanaryObservation,
  type TurnFailureSignalConfig,
} from "../domain/signal-policy.js";
import type { TurnFailureSignalStore } from "./ports.js";

export type TurnFailureEvaluationOutcome =
  | { kind: "opened"; episodeId: string; rate: number }
  | { kind: "restated"; episodeId: string; rate: number }
  | { kind: "closed"; episodeId: string; source: "normalized" | "canary-red" }
  | { kind: "held"; episodeId: string }
  | { kind: "none" };

export type TurnFailureSignalDeps = {
  readCanary: (now: number) => CanaryObservation;
  logger?: { warn: (obj: unknown, msg: string) => void };
};

export type TurnFailureSignalOptions = {
  config: TurnFailureSignalConfig;
};

export function createTurnFailureSignalService(
  store: TurnFailureSignalStore,
  deps: TurnFailureSignalDeps,
  options: TurnFailureSignalOptions,
) {
  const config = options.config;

  async function evaluate(
    companyId: string,
    input: { now: string },
  ): Promise<TurnFailureEvaluationOutcome> {
    const nowMs = Date.parse(input.now);
    const windowEnd = input.now;
    const windowStart = new Date(nowMs - config.windowMs).toISOString();
    const [stats, canary, active] = await Promise.all([
      store.countClaudeLocalOutcomes(companyId, { windowStart, windowEnd }),
      Promise.resolve(deps.readCanary(nowMs)),
      store.getActiveDegradationEpisode(companyId),
    ]);

    if (active) {
      const decision = decideDegradationHold({ stats, canary, episode: active, now: input.now, config });
      if (decision.action === "close") {
        await store.closeDegradationEpisode(active.id, {
          closedAt: input.now,
          source: decision.source,
        });
        deps.logger?.warn(
          {
            companyId,
            episodeId: active.id,
            source: decision.source,
            stats: summarize(stats),
          },
          "turn-failure degradation episode closed",
        );
        return { kind: "closed", episodeId: active.id, source: decision.source };
      }
      if (decision.action === "restate") {
        await store.markDegradationRestated(active.id, { restatedAt: input.now });
        deps.logger?.warn(
          {
            companyId,
            episodeId: active.id,
            rate: round(turnFailureRate(stats)),
            stats: summarize(stats),
          },
          "turn-failure degradation episode still red (restated)",
        );
        return { kind: "restated", episodeId: active.id, rate: round(turnFailureRate(stats)) };
      }
      return { kind: "held", episodeId: active.id };
    }

    const decision = decideDegradationOpen({ stats, canary, config });
    if (decision.action !== "open") {
      return { kind: "none" };
    }
    const episode = await store.insertDegradationEpisode(companyId, { startedAt: input.now });
    deps.logger?.warn(
      {
        companyId,
        episodeId: episode.id,
        rate: round(turnFailureRate(stats)),
        stats: summarize(stats),
      },
      "turn-failure degradation episode opened (canary green, failure rate elevated)",
    );
    return { kind: "opened", episodeId: episode.id, rate: round(turnFailureRate(stats)) };
  }

  return { evaluate };
}

function summarize(stats: {
  outcomes: number;
  authFailures: number;
  otherFailures: number;
}) {
  return {
    outcomes: stats.outcomes,
    authFailures: stats.authFailures,
    otherFailures: stats.otherFailures,
  };
}

function round(rate: number): number {
  return Math.round(rate * 1000) / 1000;
}

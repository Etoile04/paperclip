import {
  AUTH_RECOVERY_MAX_ATTEMPTS_PER_AGENT,
  AUTH_RECOVERY_MAX_WAKES_PER_EPISODE,
  buildRecoveryAnnotation,
  decideEpisodeOnAuthFailure,
  decideEpisodeOnGreen,
  decideEnrollmentRetry,
  nextRetryDueAt,
  planEpisodeReenrollments,
  shouldCloseEpisode,
  type EnrollmentState,
  type LatchEvidence,
} from "../domain/policy.js";
import type {
  AuthRecoveryStore,
  AuthRecoveryWakeEnqueuer,
} from "./ports.js";

export type AuthRecoveryGreenResult = {
  woken: number;
  manual: number;
  recovered: number;
};

export type AuthRecoverySweepResult = {
  fired: number;
  succeeded: number;
  exhausted: number;
};

export type AuthRecoveryOptions = {
  maxWakes?: number;
  maxAttempts?: number;
  logger?: Pick<Console, "warn">;
};

export function authRecoveryIdempotencyKey(input: {
  episodeId: string;
  agentId: string;
  attempt: number;
}): string {
  return `auth-recovery-reenqueue:${input.episodeId}:${input.agentId}:${input.attempt}`;
}

function sortedEnrollments<T extends { firstLatchedAt: string; agentId: string }>(
  enrollments: T[],
): T[] {
  return [...enrollments].sort((a, b) => {
    const byLatch = Date.parse(a.firstLatchedAt) - Date.parse(b.firstLatchedAt);
    return byLatch !== 0 ? byLatch : a.agentId.localeCompare(b.agentId);
  });
}

function latchFor(latches: Array<{ agentId: string; firstLatchedAt: string; firstLatchedRunId: string | null }>, agentId: string) {
  return latches.find((latch) => latch.agentId === agentId) ?? null;
}

export function createAuthRecoveryService(
  store: AuthRecoveryStore,
  enqueuer: AuthRecoveryWakeEnqueuer,
  options: AuthRecoveryOptions = {},
) {
  const maxWakes = options.maxWakes ?? AUTH_RECOVERY_MAX_WAKES_PER_EPISODE;
  const maxAttempts = options.maxAttempts ?? AUTH_RECOVERY_MAX_ATTEMPTS_PER_AGENT;

  /**
   * A `claude_auth_required` run failure. Opens/pauses the episode; never
   * wakes anyone (AC3 — green observation is the only trigger).
   */
  async function observeAuthFailure(
    companyId: string,
    input: { at: string },
  ): Promise<void> {
    const active = await store.getActiveEpisode(companyId);
    const decision = decideEpisodeOnAuthFailure(active);
    if (decision.action === "open") {
      await store.insertEpisode(companyId, { startedAt: input.at });
    } else if (decision.action === "pause" && active) {
      await store.markEpisodeRed(active.id);
    }
  }

  /**
   * A green observation (successful authenticated `claude_local` run, or the
   * sibling canary signal). Only a red episode reacts: it snaps to
   * `recovering`, re-enqueues the still-latched within bounds, and
   * annotates the latched `errorReason` surface (R4).
   */
  async function observeGreen(
    companyId: string,
    input: { at: string; runId?: string | null; source?: "run" | "canary" },
  ): Promise<AuthRecoveryGreenResult> {
    const active = await store.getActiveEpisode(companyId);
    if (decideEpisodeOnGreen(active).action === "noop" || !active) {
      return { woken: 0, manual: 0, recovered: 0 };
    }
    await store.markEpisodeRecovering(active.id, {
      greenAt: input.at,
      greenRunId: input.runId ?? null,
      greenSource: input.source ?? "run",
    });

    const [latches, succeededAgentIds, enrollments] = await Promise.all([
      store.listLatchEvidence(companyId, active.startedAt),
      store.listAgentsSucceededSince(companyId, active.startedAt),
      store.listEnrollments(active.id),
    ]);
    const succeeded = new Set(succeededAgentIds);
    const attemptsByAgent = new Map(
      enrollments.map((enrollment) => [enrollment.agentId, enrollment.attempts]),
    );
    const evidence: LatchEvidence[] = latches.map((latch) => ({
      agentId: latch.agentId,
      firstLatchedAt: latch.firstLatchedAt,
      isStillLatched: latch.isStillLatched,
      hasSuccessfulRunSinceEpisodeStart: succeeded.has(latch.agentId),
      alreadyEnrolledAttempts: attemptsByAgent.get(latch.agentId) ?? 0,
    }));

    const plan = planEpisodeReenrollments({
      evidence,
      wakesUsed: active.wakesUsed,
      maxWakes,
      maxAttempts,
      now: input.at,
    });

    // Upsert rows first so the claim below is a CAS against a persisted
    // attempt counter — two near-simultaneous greens cannot both fire.
    await store.upsertEnrollments(active.id, active.companyId, [
      ...plan.reenqueued.map((item) => ({
        agentId: item.agentId,
        firstLatchedAt: latchFor(latches, item.agentId)?.firstLatchedAt ?? input.at,
        firstLatchedRunId: latchFor(latches, item.agentId)?.firstLatchedRunId ?? null,
        state: "reenqueued" as EnrollmentState,
      })),
      ...plan.manual.map((agentId) => ({
        agentId,
        firstLatchedAt: latchFor(latches, agentId)?.firstLatchedAt ?? input.at,
        firstLatchedRunId: latchFor(latches, agentId)?.firstLatchedRunId ?? null,
        state: "manual" as EnrollmentState,
      })),
      ...plan.exhausted.map((agentId) => ({
        agentId,
        firstLatchedAt: latchFor(latches, agentId)?.firstLatchedAt ?? input.at,
        firstLatchedRunId: latchFor(latches, agentId)?.firstLatchedRunId ?? null,
        state: "exhausted" as EnrollmentState,
      })),
    ]);

    let woken = 0;
    for (const item of plan.reenqueued) {
      // The claim is the gate: only one caller can take attempt N from N-1.
      const claimed = await store.claimRetry(active.id, item.agentId, item.attempt - 1, {
        lastWakeAt: input.at,
        nextAttemptAt: nextRetryDueAt(input.at),
      });
      if (!claimed) continue;
      await enqueuer.enqueueAuthRecoveryWake({
        agentId: item.agentId,
        episodeId: active.id,
        attempt: item.attempt,
        idempotencyKey: authRecoveryIdempotencyKey({
          episodeId: active.id,
          agentId: item.agentId,
          attempt: item.attempt,
        }),
      });
      woken += 1;
    }
    if (woken > 0) {
      await store.addEpisodeWakes(active.id, woken);
    }

    // Cumulative fleet counts feed the annotation (AC4).
    const reenqueuedCount = active.reenqueuedCount + woken;
    const manualCount = active.manualCount + plan.manual.length;
    if (woken > 0 || plan.manual.length > 0) {
      await store.setEpisodeCounts(active.id, { reenqueuedCount, manualCount });
    }

    for (const item of plan.reenqueued) {
      await store.setAgentErrorReason(
        item.agentId,
        buildRecoveryAnnotation({
          recoveredAt: input.at,
          reenqueuedCount,
          manualCount,
          maxWakes,
          agent: {
            disposition: "reenqueued",
            attempt: item.attempt,
            maxAttempts,
            nextAttemptAt: nextRetryDueAt(input.at),
          },
        }),
      );
    }
    for (const agentId of plan.manual) {
      await store.setAgentErrorReason(
        agentId,
        buildRecoveryAnnotation({
          recoveredAt: input.at,
          reenqueuedCount,
          manualCount,
          maxWakes,
          agent: { disposition: "manual" },
        }),
      );
    }
    for (const agentId of plan.exhausted) {
      await store.setAgentErrorReason(
        agentId,
        buildRecoveryAnnotation({
          recoveredAt: input.at,
          reenqueuedCount,
          manualCount,
          maxWakes,
          agent: {
            disposition: "exhausted",
            attempt: attemptsByAgent.get(agentId) ?? maxAttempts,
            maxAttempts,
          },
        }),
      );
    }

    return { woken, manual: plan.manual.length, recovered: plan.recovered.length };
  }

  /**
   * Periodic pass: fires due retries inside the bounds, marks recovered
   * agents, and closes the episode once every enrollment is terminal.
   * Runs only on a `recovering` episode (AC3 — red never wakes).
   */
  async function sweepRetries(
    companyId: string,
    input: { now: string },
  ): Promise<AuthRecoverySweepResult> {
    const active = await store.getActiveEpisode(companyId);
    if (!active || active.state !== "recovering") {
      return { fired: 0, succeeded: 0, exhausted: 0 };
    }
    const enrollments = sortedEnrollments(await store.listEnrollments(active.id));
    let wakesUsed = active.wakesUsed;
    let fired = 0;
    let succeeded = 0;
    let exhausted = 0;
    for (const enrollment of enrollments) {
      const [stillLatched, hasSuccess] = await Promise.all([
        store.isAgentStillLatched(companyId, enrollment.agentId),
        store.agentHasSuccessSince(companyId, enrollment.agentId, active.startedAt),
      ]);
      const decision = decideEnrollmentRetry({
        enrollment,
        isStillLatched: stillLatched,
        hasSuccessfulRunSinceEpisodeStart: hasSuccess,
        wakesUsed,
        maxWakes,
        maxAttempts,
        now: input.now,
      });
      if (decision.action === "mark_succeeded") {
        await store.markEnrollment(active.id, enrollment.agentId, "succeeded", {
          resolvedAt: input.now,
        });
        succeeded += 1;
      } else if (decision.action === "mark_exhausted") {
        await store.markEnrollment(active.id, enrollment.agentId, "exhausted", {
          resolvedAt: input.now,
        });
        exhausted += 1;
        await store.setAgentErrorReason(
          enrollment.agentId,
          buildRecoveryAnnotation({
            recoveredAt: active.firstGreenAt ?? input.now,
            reenqueuedCount: active.reenqueuedCount,
            manualCount: active.manualCount,
            maxWakes,
            agent: { disposition: "exhausted", attempt: enrollment.attempts, maxAttempts },
          }),
        );
      } else if (decision.action === "wake") {
        const claimed = await store.claimRetry(
          active.id,
          enrollment.agentId,
          enrollment.attempts,
          { lastWakeAt: input.now, nextAttemptAt: nextRetryDueAt(input.now) },
        );
        if (!claimed) continue;
        await enqueuer.enqueueAuthRecoveryWake({
          agentId: enrollment.agentId,
          episodeId: active.id,
          attempt: decision.attempt,
          idempotencyKey: authRecoveryIdempotencyKey({
            episodeId: active.id,
            agentId: enrollment.agentId,
            attempt: decision.attempt,
          }),
        });
        wakesUsed += 1;
        fired += 1;
        await store.setAgentErrorReason(
          enrollment.agentId,
          buildRecoveryAnnotation({
            recoveredAt: active.firstGreenAt ?? input.now,
            reenqueuedCount: active.reenqueuedCount,
            manualCount: active.manualCount,
            maxWakes,
            agent: {
              disposition: "reenqueued",
              attempt: decision.attempt,
              maxAttempts,
              nextAttemptAt: nextRetryDueAt(input.now),
            },
          }),
        );
      }
    }
    const fresh = await store.listEnrollments(active.id);
    if (shouldCloseEpisode(fresh)) {
      await store.markEpisodeClosed(active.id, input.now);
    }
    return { fired, succeeded, exhausted };
  }

  return { observeAuthFailure, observeGreen, sweepRetries };
}

export type AuthRecoveryService = ReturnType<typeof createAuthRecoveryService>;

// NFM-5748 — auth-episode re-enqueue policy (pure decision layer).
// R2+R4 of the NFM-5746 CTO ruling: after a `claude_auth_required` episode,
// re-enqueue wakeups for still-latched agents once the provider observes a
// green authenticated session, with hard bounds (≤3 attempts per agent,
// 10 minutes apart, 20 wakes per episode) and an operator-readable
// recovery annotation on the latched `errorReason` surface.

export const AUTH_RECOVERY_ERROR_CODE = "claude_auth_required";
export const AUTH_RECOVERY_WAKE_REASON = "auth_recovery_reenqueue";
export const AUTH_RECOVERY_GREEN_ADAPTER_TYPES = new Set(["claude_local"]);
export const AUTH_RECOVERY_MAX_ATTEMPTS_PER_AGENT = 3;
export const AUTH_RECOVERY_RETRY_SPACING_MS = 10 * 60 * 1000;
export const AUTH_RECOVERY_MAX_WAKES_PER_EPISODE = 20;

export type EpisodeState = "red" | "recovering" | "closed";

export type EnrollmentState =
  | "enrolled"
  | "reenqueued"
  | "succeeded"
  | "exhausted"
  | "manual";

export type ActiveEpisodeLike = {
  id: string;
  state: EpisodeState;
};

export type LatchEvidence = {
  agentId: string;
  firstLatchedAt: string;
  isStillLatched: boolean;
  hasSuccessfulRunSinceEpisodeStart: boolean;
  alreadyEnrolledAttempts: number;
  /** Last wake this episode already fired for the agent, if any. */
  lastWakeAt?: string | null;
};

export type ReenrollPlanItem = {
  agentId: string;
  attempt: number;
};

export type ReenrollPlan = {
  reenqueued: ReenrollPlanItem[];
  manual: string[];
  exhausted: string[];
  recovered: string[];
  /** Still-latched retries whose 10-minute spacing has not elapsed yet. */
  waiting: string[];
};

export type EpisodeFailureDecision = { action: "open" } | { action: "noop" } | { action: "pause" };
export type EpisodeGreenDecision = { action: "recover" } | { action: "noop" };

/**
 * Auth failures only shape the episode; they never wake anyone (AC3).
 * - no active episode → open a red one
 * - red already open → the latch evidence window simply keeps growing
 * - recovering → the provider re-broke: drop back to red so due retries
 *   pause until the next green observation re-triggers recovery.
 */
export function decideEpisodeOnAuthFailure(active: ActiveEpisodeLike | null): EpisodeFailureDecision {
  if (!active || active.state === "closed") return { action: "open" };
  if (active.state === "red") return { action: "noop" };
  return { action: "pause" };
}

/** Only a green observation while red recovers an episode (AC3). */
export function decideEpisodeOnGreen(active: ActiveEpisodeLike | null): EpisodeGreenDecision {
  if (active?.state === "red") return { action: "recover" };
  return { action: "noop" };
}

/**
 * Turns latch evidence into the bounded wake plan for a green observation.
 * Eligible = still-latched with no successful run since the episode started
 * (AC1); duplicate latches arrive pre-collapsed per agent. Deterministic
 * order (first latch, then agent id) decides who hits the episode cap (AC2).
 */
export function planEpisodeReenrollments(input: {
  evidence: LatchEvidence[];
  wakesUsed: number;
  maxWakes?: number;
  maxAttempts?: number;
  now: string;
}): ReenrollPlan {
  const maxWakes = input.maxWakes ?? AUTH_RECOVERY_MAX_WAKES_PER_EPISODE;
  const maxAttempts = input.maxAttempts ?? AUTH_RECOVERY_MAX_ATTEMPTS_PER_AGENT;
  const nowMs = Date.parse(input.now);
  const recovered: string[] = [];
  const exhausted: string[] = [];
  const waiting: string[] = [];
  const candidates: LatchEvidence[] = [];
  const seen = new Set<string>();
  for (const entry of input.evidence) {
    // Defensive: collapse duplicate evidence again so one agent can never
    // consume two wake slots even if a store implementation regroups badly.
    if (seen.has(entry.agentId)) continue;
    seen.add(entry.agentId);
    if (entry.hasSuccessfulRunSinceEpisodeStart || !entry.isStillLatched) {
      recovered.push(entry.agentId);
      continue;
    }
    if (entry.alreadyEnrolledAttempts >= maxAttempts) {
      exhausted.push(entry.agentId);
      continue;
    }
    // Retry attempts (already woken before) honor the 10-minute spacing even
    // when a re-green lands early; first wakes have no spacing constraint.
    if (
      entry.alreadyEnrolledAttempts > 0 &&
      entry.lastWakeAt &&
      nowMs < Date.parse(nextRetryDueAt(entry.lastWakeAt))
    ) {
      waiting.push(entry.agentId);
      continue;
    }
    candidates.push(entry);
  }
  candidates.sort((a, b) => {
    const byLatch = Date.parse(a.firstLatchedAt) - Date.parse(b.firstLatchedAt);
    return byLatch !== 0 ? byLatch : a.agentId.localeCompare(b.agentId);
  });
  let budget = Math.max(0, maxWakes - Math.max(0, input.wakesUsed));
  const reenqueued: ReenrollPlanItem[] = [];
  const manual: string[] = [];
  for (const candidate of candidates) {
    if (budget <= 0) {
      manual.push(candidate.agentId);
      continue;
    }
    reenqueued.push({ agentId: candidate.agentId, attempt: candidate.alreadyEnrolledAttempts + 1 });
    budget -= 1;
  }
  return { reenqueued, manual, exhausted, recovered, waiting };
}

export type EnrollmentRetryDecision =
  | { action: "mark_succeeded" }
  | { action: "wake"; attempt: number }
  | { action: "mark_exhausted" }
  | { action: "wait"; dueAt: string }
  | { action: "noop" };

const TERMINAL_ENROLLMENT_STATES = new Set<EnrollmentState>(["succeeded", "exhausted", "manual"]);

/**
 * One enrollment's retry decision at sweep time. "Stop on success" covers
 * both a successful run and an agent that left error by other means —
 * either way it is recovered and must not be woken again.
 */
export function decideEnrollmentRetry(input: {
  enrollment: { state: EnrollmentState; attempts: number; lastWakeAt: string | null };
  isStillLatched: boolean;
  hasSuccessfulRunSinceEpisodeStart: boolean;
  wakesUsed: number;
  maxWakes?: number;
  maxAttempts?: number;
  now: string;
}): EnrollmentRetryDecision {
  if (TERMINAL_ENROLLMENT_STATES.has(input.enrollment.state)) return { action: "noop" };
  if (input.hasSuccessfulRunSinceEpisodeStart || !input.isStillLatched) {
    return { action: "mark_succeeded" };
  }
  const maxWakes = input.maxWakes ?? AUTH_RECOVERY_MAX_WAKES_PER_EPISODE;
  const maxAttempts = input.maxAttempts ?? AUTH_RECOVERY_MAX_ATTEMPTS_PER_AGENT;
  if (input.enrollment.attempts >= maxAttempts || input.wakesUsed >= maxWakes) {
    return { action: "mark_exhausted" };
  }
  const dueAt = nextRetryDueAt(input.enrollment.lastWakeAt ?? input.now);
  if (Date.parse(input.now) < Date.parse(dueAt)) return { action: "wait", dueAt };
  return { action: "wake", attempt: input.enrollment.attempts + 1 };
}

export function nextRetryDueAt(lastWakeAt: string): string {
  return new Date(Date.parse(lastWakeAt) + AUTH_RECOVERY_RETRY_SPACING_MS).toISOString();
}

/** An episode closes when no enrollment can still produce a wake. */
export function shouldCloseEpisode(enrollments: Array<{ state: EnrollmentState }>): boolean {
  return enrollments.every((enrollment) => TERMINAL_ENROLLMENT_STATES.has(enrollment.state));
}

/**
 * The R4 surface: the annotation operators read on the latched agent's
 * `errorReason`, with the fleet counts and (optionally) this agent's
 * disposition appended.
 */
export function buildRecoveryAnnotation(input: {
  recoveredAt: string;
  reenqueuedCount: number;
  manualCount: number;
  maxWakes?: number;
  agent?: {
    disposition: "reenqueued" | "manual" | "exhausted";
    attempt?: number;
    maxAttempts?: number;
    nextAttemptAt?: string;
  };
}): string {
  const maxWakes = input.maxWakes ?? AUTH_RECOVERY_MAX_WAKES_PER_EPISODE;
  let text =
    `auth recovered at ${input.recoveredAt}` +
    ` — ${input.reenqueuedCount} agents re-enqueued / ${input.manualCount} manual` +
    ` (wake cap ${maxWakes}/episode)`;
  const agent = input.agent;
  if (agent?.disposition === "reenqueued") {
    const attempt = agent.attempt ?? 1;
    const maxAttempts = agent.maxAttempts ?? AUTH_RECOVERY_MAX_ATTEMPTS_PER_AGENT;
    text += `; this agent: wake ${attempt}/${maxAttempts} enqueued`;
    if (agent.nextAttemptAt) text += `, next retry after ${agent.nextAttemptAt}`;
  } else if (agent?.disposition === "manual") {
    text += "; this agent: manual — wake cap reached, needs a manual wake";
  } else if (agent?.disposition === "exhausted") {
    const attempt = agent.attempt ?? AUTH_RECOVERY_MAX_ATTEMPTS_PER_AGENT;
    const maxAttempts = agent.maxAttempts ?? AUTH_RECOVERY_MAX_ATTEMPTS_PER_AGENT;
    text += `; this agent: ${attempt}/${maxAttempts} wakes did not produce a successful run — manual wake required`;
  }
  return text;
}

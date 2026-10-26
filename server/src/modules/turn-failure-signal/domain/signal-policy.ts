// NFM-5774 — turn-failure-rate passive signal (pure decision layer).
// WP1.2 of the NFM-5772 epic (ADR-026 §5 option 2): a rolling-window rate of
// live `claude_local` turn failures + auth failures — "the fleet is the probe".
// The alarm fires only on the FULL signature: canary green AND the failure
// rate elevated. The R1 canary (NFM-5747) stays the credential-liveness
// authority; this signal is additive and emits into the existing (post-PR-#39)
// episode machinery as a degradation-class episode.
//
// NON-GOAL (ratified deferral, ADR-026 §5 option 3): a concurrency-class probe
// (bounded burst of k small probes per tick) is explicitly OUT OF SCOPE here.
// Adoption trigger = one confirmed canary-blind degradation episode this
// passive signal misses (>10 min undetected). Do not add probe bursts here.

/** Rolling-window outcome counts for `claude_local` runs in one company. */
export type TurnFailureWindowStats = {
  /** Terminal, attributable turn outcomes: succeeded | failed | timed_out. */
  outcomes: number;
  /** Failed/timed-out runs whose errorCode is a provider-auth failure. */
  authFailures: number;
  /** Failed/timed-out runs with any other errorCode (or none). */
  otherFailures: number;
  windowStart: string;
  windowEnd: string;
};

/**
 * Canary observation as consumed from the R1 canary state file (NFM-5747).
 * `unknown` covers missing/unparseable/stale state — the canary is the
 * credential-liveness authority, so an unreadable canary can never confirm
 * the green half of the signature.
 */
export type CanaryObservation = {
  state: "green" | "red" | "unknown";
  observedAt: string | null;
};

export type TurnFailureSignalConfig = {
  /** Rolling window length for the counters. */
  windowMs: number;
  /** Open the alarm at or above this failure rate. */
  elevationThreshold: number;
  /** Close the alarm at or below this rate (hysteresis below elevation). */
  recoveryThreshold: number;
  /** Minimum attributable outcomes in the window before the rate is trusted. */
  minSamples: number;
  /** Minimum spacing between restatements while a degradation episode stays red. */
  restateIntervalMs: number;
};

export type DegradationEpisodeLike = {
  id: string;
  state: "red" | "closed";
  startedAt: string;
  lastRestatedAt: string | null;
};

export type DegradationOpenDecision =
  | { action: "open" }
  | { action: "noop"; reason: "canary-not-green" | "rate-normal" | "insufficient-samples" };

export type DegradationHoldDecision =
  | { action: "close"; source: "normalized" | "canary-red" }
  | { action: "restate" }
  | { action: "hold" };

export function turnFailureRate(stats: TurnFailureWindowStats): number {
  if (stats.outcomes <= 0) return 0;
  return (stats.authFailures + stats.otherFailures) / stats.outcomes;
}

/**
 * The open decision is the full-signature gate (ADR-026 §5 option 2):
 * canary green AND rate ≥ elevation threshold AND enough samples to trust
 * the rate. Each `noop` reason names the leg that failed so logs explain
 * why a given tick stayed quiet.
 */
export function decideDegradationOpen(input: {
  stats: TurnFailureWindowStats;
  canary: CanaryObservation;
  config: TurnFailureSignalConfig;
}): DegradationOpenDecision {
  const { stats, canary, config } = input;
  if (canary.state !== "green") return { action: "noop", reason: "canary-not-green" };
  if (stats.outcomes < config.minSamples) {
    return { action: "noop", reason: "insufficient-samples" };
  }
  if (turnFailureRate(stats) < config.elevationThreshold) {
    return { action: "noop", reason: "rate-normal" };
  }
  return { action: "open" };
}

/**
 * While a degradation episode is open:
 * - canary red → the credential-liveness authority owns the incident; the
 *   degradation episode closes and hands off to the auth machinery.
 * - rate recovered (≤ recovery threshold, with samples) → normalized; close.
 * - canary unreadable → hold: the episode stays open but never restates on
 *   unknown evidence (fail-safe: no confirmed signature, no new emission).
 * - still elevated on green canary → restate at most once per interval,
 *   mirroring the R1 restate-≤1/h discipline (no re-page storm while red).
 */
export function decideDegradationHold(input: {
  stats: TurnFailureWindowStats;
  canary: CanaryObservation;
  episode: DegradationEpisodeLike;
  now: string;
  config: TurnFailureSignalConfig;
}): DegradationHoldDecision {
  const { stats, canary, episode, now, config } = input;
  if (canary.state === "red") return { action: "close", source: "canary-red" };
  const samplesTrusted = stats.outcomes >= config.minSamples;
  if (canary.state === "green" && samplesTrusted && turnFailureRate(stats) <= config.recoveryThreshold) {
    return { action: "close", source: "normalized" };
  }
  if (canary.state !== "green") return { action: "hold" };
  if (shouldRestateDegradation({
    lastRestatedAt: episode.lastRestatedAt,
    episodeStartedAt: episode.startedAt,
    now,
    restateIntervalMs: config.restateIntervalMs,
  })) {
    return { action: "restate" };
  }
  return { action: "hold" };
}

/**
 * Restate spacing measured from the last restatement, or — for an episode
 * that has never restated — from the open itself: opening IS the first
 * emission, so the first restate owes a full interval after it.
 */
export function shouldRestateDegradation(input: {
  lastRestatedAt: string | null;
  episodeStartedAt: string;
  now: string;
  restateIntervalMs: number;
}): boolean {
  const nowMs = Date.parse(input.now);
  const reference = input.lastRestatedAt ?? input.episodeStartedAt;
  return nowMs - Date.parse(reference) >= input.restateIntervalMs;
}

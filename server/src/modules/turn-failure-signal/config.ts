// NFM-5774 — env knobs for the turn-failure-rate passive signal.
//
// The signal is DISABLED until `TURN_FAILURE_SIGNAL_CANARY_STATE_PATH` points
// at the R1 canary's state file (NFM-5747): the alarm signature requires a
// positively-confirmed green canary, so without the file there is nothing to
// evaluate. All numeric knobs are optional; the defaults below are the
// initial calibration proposed on the NFM-5774 PR (see doc/TURN-FAILURE-SIGNAL.md).

import type { TurnFailureSignalConfig } from "./domain/signal-policy.js";

export const TURN_FAILURE_SIGNAL_DEFAULTS = {
  windowMs: 15 * 60 * 1000,
  elevationThreshold: 0.5,
  recoveryThreshold: 0.25,
  minSamples: 10,
  canaryMaxAgeMs: 2 * 60 * 60 * 1000,
  restateIntervalMs: 60 * 60 * 1000,
} as const;

export type ResolvedTurnFailureSignalConfig = TurnFailureSignalConfig & {
  canaryStatePath: string | null;
  canaryMaxAgeMs: number;
  enabled: boolean;
};

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampRate(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function resolveTurnFailureSignalConfig(env: Record<string, string | undefined>): ResolvedTurnFailureSignalConfig {
  const canaryStatePath = env.TURN_FAILURE_SIGNAL_CANARY_STATE_PATH?.trim() || null;
  const elevationThreshold = clampRate(
    num(env, "TURN_FAILURE_SIGNAL_ELEVATION_THRESHOLD", TURN_FAILURE_SIGNAL_DEFAULTS.elevationThreshold),
  );
  // Hysteresis invariant: recovery must sit strictly below elevation, else a
  // boundary-flapping window opens and closes on alternating ticks. Clamp
  // misconfigurations instead of rejecting them (the signal must stay safe).
  const recoveryThreshold = Math.min(
    clampRate(num(env, "TURN_FAILURE_SIGNAL_RECOVERY_THRESHOLD", TURN_FAILURE_SIGNAL_DEFAULTS.recoveryThreshold)),
    elevationThreshold / 2,
  );
  return {
    canaryStatePath,
    enabled: canaryStatePath !== null,
    windowMs: Math.max(60_000, num(env, "TURN_FAILURE_SIGNAL_WINDOW_MS", TURN_FAILURE_SIGNAL_DEFAULTS.windowMs)),
    elevationThreshold,
    recoveryThreshold,
    minSamples: Math.max(1, Math.round(num(env, "TURN_FAILURE_SIGNAL_MIN_SAMPLES", TURN_FAILURE_SIGNAL_DEFAULTS.minSamples))),
    canaryMaxAgeMs: Math.max(
      60_000,
      num(env, "TURN_FAILURE_SIGNAL_CANARY_MAX_AGE_MS", TURN_FAILURE_SIGNAL_DEFAULTS.canaryMaxAgeMs),
    ),
    restateIntervalMs: Math.max(
      60_000,
      num(env, "TURN_FAILURE_SIGNAL_RESTATE_INTERVAL_MS", TURN_FAILURE_SIGNAL_DEFAULTS.restateIntervalMs),
    ),
  };
}

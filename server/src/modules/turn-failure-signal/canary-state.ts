// NFM-5774 — reads the R1 provider-canary state file (NFM-5747) so the
// turn-failure signal can gate its alarm on "canary green". The file is
// owned by the SRE heartbeat's §3 Step 6 probe; this module is read-only
// and never writes credential material — the state file holds counts and
// flags only (NFM-5743 / NFM-5768 AC4 hygiene).

import { statSync } from "node:fs";
import { readFileSync } from "node:fs";

import type { CanaryObservation } from "./domain/signal-policy.js";

export type CanaryStateFileShape = {
  consecutive_failures?: unknown;
  episode_open?: unknown;
};

export type CanaryStateReaderDeps = {
  readFile?: (path: string) => string;
  mtimeMs?: (path: string) => number;
};

/** A canary state older than this is treated as unreadable (probe down). */
export const DEFAULT_CANARY_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function parseCanaryState(raw: string): CanaryStateFileShape | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as CanaryStateFileShape;
  } catch {
    return null;
  }
}

/**
 * Map the canary state file onto a `CanaryObservation`. Any doubt — missing
 * file, unreadable, malformed, stale mtime, non-numeric counters — resolves
 * to `unknown`, never to green: the canary is the credential-liveness
 * authority and its green leg must be positively confirmed.
 */
export function readCanaryState(
  path: string,
  input: { now: number; maxAgeMs?: number; deps?: CanaryStateReaderDeps } = {
    now: Date.now(),
  },
): CanaryObservation {
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_CANARY_MAX_AGE_MS;
  const readFile = input.deps?.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const mtimeMs = input.deps?.mtimeMs ?? ((p: string) => statSync(p).mtimeMs);
  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    return { state: "unknown", observedAt: null };
  }
  let mtime: number;
  try {
    mtime = mtimeMs(path);
  } catch {
    return { state: "unknown", observedAt: null };
  }
  if (!Number.isFinite(mtime) || input.now - mtime > maxAgeMs) {
    return { state: "unknown", observedAt: null };
  }
  const parsed = parseCanaryState(raw);
  if (!parsed) return { state: "unknown", observedAt: null };
  const consecutiveFailures = parsed.consecutive_failures;
  const episodeOpen = parsed.episode_open;
  if (typeof consecutiveFailures !== "number" || !Number.isFinite(consecutiveFailures)) {
    return { state: "unknown", observedAt: null };
  }
  if (typeof episodeOpen !== "boolean") {
    return { state: "unknown", observedAt: null };
  }
  const state = episodeOpen || consecutiveFailures > 0 ? "red" : "green";
  return { state, observedAt: new Date(mtime).toISOString() };
}

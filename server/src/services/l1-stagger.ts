/**
 * L1 (ADR-014 §3) — per-agent wake stagger.
 *
 * Stable SHA-1 hash of `agentId` → offset in [-HEARTBEAT_JITTER_MINUTES,
 * +HEARTBEAT_JITTER_MINUTES] minutes, applied to `monitorNextCheckAt`
 * derivation. The same agent always gets the same offset, so the stagger
 * is stable across heartbeat ticks. Two distinct agents with high
 * probability get distinct offsets, so they desync on the per-tick
 * selector without any explicit cluster coordination.
 */

import { createHash } from "node:crypto";

import { HEARTBEAT_JITTER_MINUTES } from "./fleet-throttle-constants.js";

const MS_PER_MINUTE = 60 * 1000;

/**
 * Pure: deterministic offset in ms for the given agentId.
 *
 * Implementation: SHA-1 of `agentId`, take first 4 bytes as an unsigned
 * 32-bit integer, normalize to [-1, +1], scale by jitter minutes. The
 * constant-folded `2 ** 32 - 1` is `0xffffffff`.
 */
export function agentStaggerOffsetMs(agentId: string): number {
  const digest = createHash("sha1").update(agentId, "utf8").digest();
  // Read first 4 bytes as big-endian unsigned int.
  const uint = (digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3];
  // Normalize to [-1, +1] (signed shift to spread the bias off zero).
  const normalized = (uint >>> 0) / 0xffffffff; // [0, 1]
  const signed = normalized * 2 - 1; // [-1, +1]
  return Math.round(signed * HEARTBEAT_JITTER_MINUTES * MS_PER_MINUTE);
}

/**
 * Apply the L1 jitter to a `nextCheckAt` Date. The result is monotonic in
 * `nextCheckAt` modulo the offset, and stable for a fixed `agentId`.
 */
export function applyL1Stagger(nextCheckAt: Date, agentId: string): Date {
  return new Date(nextCheckAt.getTime() + agentStaggerOffsetMs(agentId));
}
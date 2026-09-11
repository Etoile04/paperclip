/**
 * L5 (ADR-014 §3, CEO-DIRECTIVE NFM-4689) — fleet dispatch guard.
 *
 * Stateless two-predicate gate:
 *   - isHeavy   (estimated token count >= HEAVY_DISPATCH_TOKEN_THRESHOLD)
 *   - isTripped (L4 burn-budget returns `tripped`)
 *
 * Verdict matrix:
 *   isTripped=false                                  → allow
 *   isTripped=true,  isHeavy=false                   → allow_demoted (read-only preamble)
 *   isTripped=true,  isHeavy=true                    → block (wake not enqueued)
 *
 * The caller (`heartbeat.ts` enqueueWakeup site) is responsible for:
 *   1. Computing isHeavy from the wake's payload/token estimate.
 *   2. Consulting L4 (`agent-burn-budget.ts`) for isTripped.
 *   3. Passing the verdict into the wake flow — `allow` proceeds normally,
 *      `allow_demoted` attaches `contextSnapshot.demoteToReviewOnly = true`,
 *      `block` returns the skip reason to the heartbeat scheduler.
 *
 * Emits `fleet.dispatch.blocked` telemetry with `{agent_role, reason}`
 * dims whenever a heavy wake is blocked. Read-only demotions do NOT
 * emit telemetry (they are the expected steady state below the cap).
 */

import {
  DEMOTE_POLICY,
  HEAVY_DISPATCH_TOKEN_THRESHOLD,
} from "./fleet-throttle-constants.js";

export type DispatchVerdict = "allow" | "allow_demoted" | "block";

export type DispatchVerdictReason =
  | "no_throttle"
  | "tripped_below_threshold"
  | "tripped_above_threshold";

export type DispatchGuardInput = {
  /** Estimated token count for the wake (input + output + cached). */
  estimatedTokens: number;
  /** True when the per-agent burn budget is in the `tripped` state. */
  isTripped: boolean;
};

export type DispatchGuardVerdict = {
  verdict: DispatchVerdict;
  reason: DispatchVerdictReason;
  /** True iff the wake should attach the read-only preamble. */
  demoteToReviewOnly: boolean;
  /** True iff the wake should be blocked outright. */
  block: boolean;
  /** Non-empty when this wake is heavy enough to be subject to L4. */
  heavy: boolean;
};

/**
 * Pure verdict. Always returns a complete `DispatchGuardVerdict`; never
 * throws. Unit-test the full input matrix:
 *   estimatedTokens=0   × isTripped=false → allow
 *   estimatedTokens=0   × isTripped=true  → allow_demoted
 *   estimatedTokens=49k × isTripped=false → allow
 *   estimatedTokens=49k × isTripped=true  → allow_demoted
 *   estimatedTokens=50k × isTripped=false → allow
 *   estimatedTokens=50k × isTripped=true  → block
 */
export function evaluateDispatch(input: DispatchGuardInput): DispatchGuardVerdict {
  const heavy = input.estimatedTokens >= HEAVY_DISPATCH_TOKEN_THRESHOLD;

  if (!input.isTripped) {
    return {
      verdict: "allow",
      reason: "no_throttle",
      demoteToReviewOnly: false,
      block: false,
      heavy,
    };
  }

  if (!heavy) {
    return {
      verdict: "allow_demoted",
      reason: "tripped_below_threshold",
      demoteToReviewOnly: true,
      block: false,
      heavy,
    };
  }

  return {
    verdict: "block",
    reason: "tripped_above_threshold",
    demoteToReviewOnly: true,
    block: true,
    heavy,
  };
}

/**
 * The single string that downstream tools check on `contextSnapshot` to
 * know they are running in read-only review mode. Per CTO Locked Decision
 * the demotion tier is `read_only_review`; tools that perform write work
 * MUST refuse when this flag is set.
 */
export const CONTEXT_SNAPSHOT_DEMOTE_FLAG = "demoteToReviewOnly";
export const CONTEXT_SNAPSHOT_DEMOTE_POLICY = "demotePolicy";

/**
 * Attach the read-only preamble to a `contextSnapshot`. Returns a NEW
 * object (immutability per common/coding-style.md).
 */
export function attachReadOnlyPreamble(
  contextSnapshot: Record<string, unknown> | undefined,
  demotePolicy: typeof DEMOTE_POLICY,
): Record<string, unknown> {
  return {
    ...(contextSnapshot ?? {}),
    [CONTEXT_SNAPSHOT_DEMOTE_FLAG]: true,
    [CONTEXT_SNAPSHOT_DEMOTE_POLICY]: demotePolicy,
  };
}
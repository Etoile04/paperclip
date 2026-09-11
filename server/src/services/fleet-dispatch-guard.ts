/**
 * ADR-014 L5 — fleet-dispatch guard.
 *
 * Two-predicate gate (`isHeavy` ∧ `isTripped`) that blocks heavy wakes when
 * the per-agent L4 burn budget is tripped, or demotes them to a read-only
 * preamble when the trip policy permits in-flight demotion but blocks new.
 *
 * Verdict matrix:
 *   not heavy                → allow (cheap wake, not throttleable)
 *   heavy + not tripped      → allow
 *   heavy + tripped + demote → allow_demoted (run proceeds with read-only preamble)
 *   heavy + tripped + block  → block   (wake not enqueued)
 *
 * `dispatch.blocked:true` is attached to the contextSnapshot when block
 * is returned, so the audit trail and the agent's run summary reflect the
 * guard outcome.
 *
 * Owners: NFM-4687 (LE, implement) — see ADR-014 §3 L5.
 */

import {
  DISPATCH_VERDICT_ALLOW,
  DISPATCH_VERDICT_ALLOW_DEMOTED,
  DISPATCH_VERDICT_BLOCK,
  HEAVY_DISPATCH_TOKEN_THRESHOLD,
  TRIP_POLICY_BLOCK_NEW_HEAVY,
  TRIP_POLICY_DEMOTE_INFLIGHT,
  type FleetDispatchVerdict,
} from "./fleet-throttle-constants.js";
import type { BurnBudgetState } from "./agent-burn-budget.js";

export interface DispatchGuardInput {
  /** Caller-supplied hint: estimated tokens the wake will consume. */
  estimatedTokens?: number;
  /** Force classification regardless of estimate (e.g. CI heavy workflow). */
  forceHeavy?: boolean;
  /** L4 burn budget for the target agent. */
  burnBudget: BurnBudgetState;
}

export interface DispatchGuardResult {
  verdict: FleetDispatchVerdict;
  reason: string;
  /** Convenience flag — true iff verdict === block. */
  blocked: boolean;
}

export function isHeavyDispatch(input: { estimatedTokens?: number; forceHeavy?: boolean }): boolean {
  if (input.forceHeavy === true) return true;
  const est = input.estimatedTokens ?? 0;
  return est >= HEAVY_DISPATCH_TOKEN_THRESHOLD;
}

/**
 * Evaluate the dispatch verdict. Pure function so the unit test covers
 * the full input matrix deterministically.
 */
export function evaluateDispatch(input: DispatchGuardInput): DispatchGuardResult {
  const heavy = isHeavyDispatch(input);
  const tripped = input.burnBudget.tripped;

  if (!heavy) {
    return { verdict: DISPATCH_VERDICT_ALLOW, reason: "non_heavy", blocked: false };
  }
  if (!tripped) {
    return { verdict: DISPATCH_VERDICT_ALLOW, reason: "heavy_under_budget", blocked: false };
  }
  // Heavy + tripped — apply trip policy.
  if (TRIP_POLICY_BLOCK_NEW_HEAVY) {
    return {
      verdict: DISPATCH_VERDICT_BLOCK,
      reason: "heavy_tripped_block",
      blocked: true,
    };
  }
  if (TRIP_POLICY_DEMOTE_INFLIGHT) {
    return {
      verdict: DISPATCH_VERDICT_ALLOW_DEMOTED,
      reason: "heavy_tripped_demoted",
      blocked: false,
    };
  }
  // Trip policy disabled both flags — fall through to allow but flagged.
  return {
    verdict: DISPATCH_VERDICT_ALLOW,
    reason: "heavy_tripped_no_policy",
    blocked: false,
  };
}

/**
 * Attach the guard outcome to a contextSnapshot. Idempotent: does not
 * overwrite existing keys, just enriches.
 */
export function annotateContextSnapshot(
  base: Record<string, unknown> | null | undefined,
  result: DispatchGuardResult,
  burnBudget: BurnBudgetState,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  out.fleet_dispatch = {
    verdict: result.verdict,
    reason: result.reason,
    blocked: result.blocked,
    burn: {
      remainingPctOfCeiling: burnBudget.remainingPctOfCeiling,
      consumedTokens: burnBudget.consumedTokens,
      ceilingTokens: burnBudget.ceilingTokens,
      tripped: burnBudget.tripped,
      windowEnd: burnBudget.windowEnd.toISOString(),
    },
  };
  if (result.blocked) {
    out.dispatch = { ...(out.dispatch as Record<string, unknown> | undefined), blocked: true };
  }
  return out;
}

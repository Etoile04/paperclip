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
  DEMOTE_POLICY,
  DISPATCH_VERDICT_ALLOW,
  DISPATCH_VERDICT_ALLOW_DEMOTED,
  DISPATCH_VERDICT_BLOCK,
  HEAVY_DISPATCH_TOKEN_THRESHOLD,
  TRIP_POLICY_BLOCK_NEW_HEAVY,
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
 * Evaluate the dispatch verdict for a NEW wake. Pure function so the unit
 * test covers the full input matrix deterministically.
 *
 * Trip policy:
 *   TRIP_POLICY_BLOCK_NEW_HEAVY=true → heavy+tripped returns BLOCK (the
 *     wake is not enqueued and `dispatch.blocked:true` is propagated).
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
  // Heavy + tripped — new dispatch policy.
  if (TRIP_POLICY_BLOCK_NEW_HEAVY) {
    return {
      verdict: DISPATCH_VERDICT_BLOCK,
      reason: "fleet_cap_tripped",
      blocked: true,
    };
  }
  // Trip policy disabled the new-block flag — fall through to allow but flagged.
  return {
    verdict: DISPATCH_VERDICT_ALLOW,
    reason: "heavy_tripped_no_policy",
    blocked: false,
  };
}

/**
 * Evaluate the dispatch verdict for an IN-FLIGHT heavy run that crossed
 * the L4 trip boundary mid-execution. Always treats the dispatch as heavy
 * (`forceHeavy:true`) and applies the demote policy: heavy+tripped →
 * ALLOW_DEMOTED. The run proceeds but the caller is expected to inject the
 * DEMOTE_POLICY ("read_only_review") degraded instruction set via
 * `annotateContextSnapshot`.
 *
 * This is the L5 mid-run demote path. It is intentionally separate from
 * `evaluateDispatch` so that the new-dispatch BLOCK policy and the
 * in-flight DEMOTE policy can be reasoned about independently.
 */
export function evaluateInflightHeavyDispatch(input: {
  burnBudget: BurnBudgetState;
}): DispatchGuardResult {
  // In-flight path: caller asserts this is an existing heavy run, not a new wake.
  const heavy = true;
  const tripped = input.burnBudget.tripped;

  if (!tripped) {
    return { verdict: DISPATCH_VERDICT_ALLOW, reason: "inflight_heavy_under_budget", blocked: false };
  }
  if (!heavy) {
    // Defensive: should not happen — forceHeavy:true is always set at the call site.
    return { verdict: DISPATCH_VERDICT_ALLOW, reason: "inflight_non_heavy", blocked: false };
  }
  return {
    verdict: DISPATCH_VERDICT_ALLOW_DEMOTED,
    reason: "fleet_cap_tripped",
    blocked: false,
  };
}

/**
 * Attach the guard outcome to a contextSnapshot. Idempotent: does not
 * overwrite existing keys, just enriches.
 *
 * When the verdict is ALLOW_DEMOTED, also sets `contextSnapshot.reviewOnly=true`
 * and `contextSnapshot.reason="fleet_cap_tripped"` so the agent runtime can
 * surface the degraded instruction set (comment + PATCH + checklist mark
 * only — no file edit, no git write, no WebSearch, no Agent invocation).
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
    demotePolicy: result.verdict === DISPATCH_VERDICT_ALLOW_DEMOTED ? DEMOTE_POLICY : null,
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
    out.reviewOnly = true;
    out.reason = "fleet_cap_tripped";
  }
  if (result.verdict === DISPATCH_VERDICT_ALLOW_DEMOTED) {
    out.reviewOnly = true;
    out.reason = "fleet_cap_tripped";
  }
  return out;
}

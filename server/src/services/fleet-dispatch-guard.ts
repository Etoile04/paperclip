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

/**
 * NFM-4946 — caller-supplied heavy classification input for the wakeup
 * funnel. Structural subset of the heartbeat service's WakeupOptions so this
 * module stays importable without a circular dependency on heartbeat.ts.
 *
 * Precedence: first-class `estimatedTokens` field, then `payload`, then
 * `contextSnapshot`. The payload path is the API surface — both wakeup routes
 * forward `req.body.payload` verbatim, so agents (and board callers) can
 * classify their own wakes heavy today:
 *
 *   POST /api/agents/:id/wakeup { "payload": { "estimatedTokens": 60000 } }
 */
export interface WakeupEstimateInput {
  estimatedTokens?: number | null;
  payload?: Record<string, unknown> | null;
  contextSnapshot?: Record<string, unknown> | null;
}

/**
 * Extract a caller-supplied token estimate from wakeup options. Returns null
 * when no valid estimate is present — a null estimate is NOT heavy (the
 * pre-NFM-4946 behavior for estimate-less wakes is preserved: timer ticks and
 * legacy callers keep flowing through unclassified).
 *
 * Malformed values (non-number, negative, NaN, ±Infinity) are rejected to
 * null rather than coerced — a wrong classification is worse than none.
 */
export function extractEstimatedTokens(input: WakeupEstimateInput): number | null {
  const readValid = (value: unknown): number | null => {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  };
  // A present-but-invalid first-class estimate poisons the read rather than
  // falling back — the first-class field is code-supplied, so a malformed
  // value is a caller bug that must not be masked by payload data.
  if (input.estimatedTokens !== undefined && input.estimatedTokens !== null) {
    return readValid(input.estimatedTokens);
  }
  const fromPayload = readValid(input.payload?.estimatedTokens);
  if (fromPayload !== null) return fromPayload;
  return readValid(input.contextSnapshot?.estimatedTokens);
}

export interface WakeupDispatchClassificationInput {
  /** Validated estimate (non-null) from {@link extractEstimatedTokens}. */
  estimatedTokens: number;
  /** L4 burn budget for the target agent. */
  burnBudget: BurnBudgetState;
  /**
   * True when this wake continues an existing RUNNING run of the target
   * agent (e.g. payload.runId resolves to a running heartbeat run) — the
   * L5 in-flight demote semantics apply instead of the new-dispatch block.
   */
  inflight: boolean;
}

/**
 * NFM-4946 — route a heavy-classified wake through the L5 guard.
 *
 * In-flight continuations get `evaluateInflightHeavyDispatch` (heavy + tripped
 * → ALLOW_DEMOTED, the run proceeds with the read-only preamble), everything
 * else gets `evaluateDispatch` (heavy + tripped → BLOCK, the wake is not
 * enqueued). This is the classification TODO from NFM-4687: before this, the
 * only production caller passed `forceHeavy:false` with no estimate, so the
 * verdict was always `allow (non_heavy)` and block/demote could never fire
 * (NFM-4716 addendum §6.2).
 */
export function evaluateWakeupDispatch(
  input: WakeupDispatchClassificationInput,
): DispatchGuardResult {
  if (input.inflight) {
    // Caller already asserts heaviness by supplying an estimate ≥ threshold;
    // the in-flight evaluator unconditionally treats the dispatch as heavy.
    return evaluateInflightHeavyDispatch({ burnBudget: input.burnBudget });
  }
  return evaluateDispatch({
    estimatedTokens: input.estimatedTokens,
    burnBudget: input.burnBudget,
  });
}

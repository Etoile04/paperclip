/**
 * ADR-014 fleet token-burn throttle — named constants.
 *
 * All magic numbers for the L1/L3/L4/L5 fleet throttle live here so the
 * trip semantics, jitter window, and trip policy are auditable in one place
 * and the body AC / E2E demo can reference named symbols rather than literals.
 *
 * Owners: NFM-4687 (LE, implement) — approved per ADR-014 §3 L3/L4/L5 and §4 AC.
 */

export const FLEET_THROTTLE_NAMESPACE = "fleet_token_burn_throttle";

// L1 — per-agent wake stagger. Stable SHA-1 hash of agentId mapped into
// ±JITTER_CEIL_MINUTES, applied at monitorNextCheckAt derivation
// (issue-execution-policy.ts buildInitialIssueMonitorFields).
export const JITTER_CEIL_MINUTES = 10;

// L3 — fleet-pressure tick throttle (incident state).
// In incident state, the per-tick monitor dispatch limit halves
// and staleClaimThreshold doubles (5min → 10min).
export const FLEET_PRESSURE_LIMIT_NORMAL = 50;
export const FLEET_PRESSURE_LIMIT_INCIDENT = 25;
export const FLEET_PRESSURE_STALE_NORMAL_MS = 5 * 60 * 1000;
export const FLEET_PRESSURE_STALE_INCIDENT_MS = 10 * 60 * 1000;

// Hysteresis: must observe recovery below this many consecutive ticks before
// transitioning incident → normal, to avoid flapping under bursty load.
export const FLEET_PRESSURE_HYSTERESIS_TICKS = 3;

// L4 — per-agent token-burn budget (5h trailing window).
// Trip when remaining fraction of 5h cap drops below this threshold.
// ADR-014 §3 L4 (revised): trip early, on REMAINING, not on consumed.
export const REMAINING_PCT_BELOW_TRIP = 0.30;

// Recovery threshold for the L4 trip hysteresis gap. Once tripped, the burn
// budget only recovers when the remaining fraction crosses this upper bound.
// Between REMAINING_PCT_BELOW_TRIP and REMAINING_PCT_ABOVE_RECOVER the
// trip state holds — this is the hysteresis zone that prevents flapping
// under bursty load. Spec: NFM-4682 / NFM-4689 (CTO comment 2026-09-11).
export const REMAINING_PCT_ABOVE_RECOVER = 0.35;

// Number of consecutive ticks at or above REMAINING_PCT_ABOVE_RECOVER required
// to recover from a tripped state. Mirrors FLEET_PRESSURE_HYSTERESIS_TICKS so
// L3 and L4 trip state machines share the same anti-flap discipline.
export const BURN_BUDGET_HYSTERESIS_TICKS = 3;

// Demographic of the demote instruction set injected when the trip fires
// mid-flight. The string literal is referenced by tests, logs, and the
// agent-side degraded-instruction builder so the demote mode is auditable
// from a single source of truth.
export const DEMOTE_POLICY = "read_only_review" as const;
export type DemotePolicy = typeof DEMOTE_POLICY;

// Multiplier on the 1M-token baseline that yields the per-agent 5h ceiling
// (`DEFAULT_BURN_BUDGET_CONFIG.ceilingTokens`).
//
// NFM-4716 empirical pass (ADR-014 §4) replaced the 1.1 bootstrap with the
// p95 of per-agent MAX trailing-5h totals observed over the fixed 7-day
// window 2026-09-11T10:05Z → 2026-09-18T10:05Z (23 agents, 2,124 costEvents,
// replay of the exact readBurnBudgetForAgent slicing at 5-min ticks):
//   per-agent max 5h totals: p50=12.47M p75=27.86M p90=72.31M p95=84.18M
// At 1.1× the trip predicate fired on 33.9% of agent-ticks (5 agents
// continuously tripped for the full window) with zero real cap-exhaustion
// incidents in-window; at 84.178M it fires on 0.83% (top-3 burners at true
// peaks only). Derivation and methodology: docs/adr/ADR-014-NFM-4682-fleet-token-burn-throttle.md §4.
// Do not adjust without a new empirical window (ADR-014 §4: no hand-tuning).
export const BURN_BUDGET_BOOTSTRAP_FACTOR = 84.177659;

// L3 fleet-pressure ceiling: fleet-wide (all agents summed) trailing-5h
// consumed-token total at which the incident state machine trips
// (remaining < REMAINING_PCT_BELOW_TRIP, i.e. consumed >= 70% of this value).
//
// NFM-4716 empirical pass: p95 of the fleet-aggregate trailing-5h samples
// over the same fixed 7-day window (fleet aggregate distribution:
// p50=61.3M p90=168.2M p95=185.9M max=248.0M). Replaces the pre-empirical
// hardcoded `1_100_000 * 8` (8.8M) which held the fleet in permanent
// incident state for the entire observation window (fleet p50 was ~7× its
// trip level). At 185.9M the incident state covers ~20% of ticks — real
// heavy windows. Supersedes the ×8 parallel-agent heuristic; derive any
// future change from a new empirical window, not from agent-count guesses.
export const FLEET_PRESSURE_CEILING_TOKENS = 185_913_738;

// Test-only env flag that, when set, makes readBurnBudgetForAgent return a
// synthetic BurnBudgetState whose remainingPctOfCeiling matches the parsed
// numeric value. Production reads are unaffected — the flag is read at
// module evaluation time, and a non-numeric / unset value short-circuits
// the seam to a no-op. The flag is intentionally TEST_BURN_BUDGET_*-namespaced
// so accidental prod enablement is obvious in incident triage.
//
//   PAPERCLIP_TEST_BURN_BUDGET_OVERRIDE_REMAINING_PCT=0.25   → simulate 25%
//   PAPERCLIP_TEST_BURN_BUDGET_OVERRIDE_REMAINING_PCT=0.36   → simulate recovery
//
// See NFM-4695 (E2E demo) for the four-case scenario that exercises this seam.
export const TEST_BURN_BUDGET_OVERRIDE_ENV =
  "PAPERCLIP_TEST_BURN_BUDGET_OVERRIDE_REMAINING_PCT";

// L5 — heavy-dispatch guard (fleet-dispatch-guard.ts).
// Heavy dispatch is any wake that anticipates crossing this input-token
// threshold, derived from observed runs in the trailing 5h window.
export const HEAVY_DISPATCH_TOKEN_THRESHOLD = 50_000;

// Trip policy flags. Both must be true per CEO directive NFM-4689.
// TRIP_POLICY_BLOCK_NEW_HEAVY: L5 gate refuses to enqueue heavy wakes.
// TRIP_POLICY_DEMOTE_INFLIGHT: in-flight heavy wakes get read-only preamble.
export const TRIP_POLICY_BLOCK_NEW_HEAVY = true;
export const TRIP_POLICY_DEMOTE_INFLIGHT = true;

// Counter / log namespaces for fleet telemetry.
export const METRIC_FLEET_DISPATCH_BLOCKED = "fleet_dispatch_blocked_total";
export const METRIC_FLEET_PRESSURE_TRANSITION = "fleet_pressure_state_transition_total";
export const METRIC_AGENT_BURN_DEMOTE = "agent_burn_budget_demote_total";

// Verdict values emitted by fleet-dispatch-guard.evaluateDispatch.
export const DISPATCH_VERDICT_ALLOW = "allow" as const;
export const DISPATCH_VERDICT_ALLOW_DEMOTED = "allow_demoted" as const;
export const DISPATCH_VERDICT_BLOCK = "block" as const;

export type FleetDispatchVerdict =
  | typeof DISPATCH_VERDICT_ALLOW
  | typeof DISPATCH_VERDICT_ALLOW_DEMOTED
  | typeof DISPATCH_VERDICT_BLOCK;

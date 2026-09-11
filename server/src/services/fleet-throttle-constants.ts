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

// Bootstrap multiplier on observed baseline before sufficient post-ship
// telemetry exists. ADR-014 §4 allows this; replace only with empirical data.
export const BURN_BUDGET_BOOTSTRAP_FACTOR = 1.1;

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

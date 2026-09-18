/**
 * ADR-014 fleet token-burn throttle — named constants.
 *
 * All magic numbers for the L1/L3/L4/L5 fleet throttle live here so the
 * trip semantics, jitter window, and trip policy are auditable in one place
 * and the body AC / E2E demo can reference named symbols rather than literals.
 *
 * Owners: NFM-4687 (LE, implement) — approved per ADR-014 §3 L3/L4/L5 and §4 AC.
 * Thresholds made empirical by NFM-4716 (ADR-014 §4 pass, 2026-09-18):
 * see BURN_BUDGET_CEILING_TOKENS / FLEET_PRESSURE_CEILING_TOKENS below.
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

// L4 per-agent 5h token ceiling — empirical value from the NFM-4716 ADR-014 §4
// pass (replaces the retired 1.1× bootstrap, BURN_BUDGET_BOOTSTRAP_FACTOR).
//
// Derivation (window 2026-09-11T10:05Z → 2026-09-18T10:05Z, post-NFM-4687
// prod cost_events, consumed = input + cached_input + output, trailing-5h
// replay at 5-min samples matching agent-burn-budget.ts slicing):
//   per-agent active-sample 5h totals: p50 4.08M / p75 8.78M / p95 37.36M
//   / p99 71.36M / max 128.87M tokens.
// ceiling = p99 / 0.70 ≈ 101.9M, rounded to 100M → trip point 70M ≈ observed
// p99. Simulated effect vs the 1.1M bootstrap: tripped samples 33.9% → 1.18%
// of active samples, tripping only the three observed outlier agents and
// covering 15/23 genuine claude_usage_cap_exhausted moments (incl. both
// light-agent starvations on 2026-09-12). Full methodology:
// docs/specs/adr-014-empirical-threshold-pass.md (NFM-4716).
export const BURN_BUDGET_CEILING_TOKENS = 100_000_000;

// L3 fleet-aggregate 5h token ceiling — empirical value from the same pass.
// The anthropic OAuth fleet 5h total at genuine usage-cap-exhaustion moments
// ranged 107M–211M (median ~175M) while normal operation sat at p50 61M /
// p75 110M. Ceiling 200M → fleet trip at 140M (remaining < 0.30), above
// normal p75 and inside observed denial territory. Consequence of the L3
// incident state is a mild throttle (dispatch limit 50→25, staleClaim
// 5→10min), so a p75+ anchor is appropriate — unlike the harsher per-agent
// L5 block, which anchors at p99. The pre-empirical value (1.1M × 8 = 8.8M)
// left L3 permanently in incident state since NFM-4687 shipped.
export const FLEET_PRESSURE_CEILING_TOKENS = 200_000_000;

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

/**
 * ADR-014 (NFM-4682) named constants — locked by CEO-DIRECTIVE NFM-4689 on
 * 2026-09-11. These three params are the entire contract for the fleet
 * token-burn throttle; do not hand-tune. Empirical revisit per ADR-014 §4
 * after 7 days of post-NFM-4658 ship data.
 *
 *   - HEARTBEAT_JITTER_MINUTES         (L1 stagger — issue-execution-policy.ts:988)
 *   - FLEET_CAP_TRIP_REMAINING_PCT     (L4 trip   — agent-burn-budget.ts)
 *   - DEMOTE_POLICY                    (L4 demote — agent-burn-budget.ts / fleet-dispatch-guard.ts)
 *
 * Implementation hint: every numeric tolerance and threshold lives here.
 * Other modules import the named symbols, never the literals.
 */

export const HEARTBEAT_JITTER_MINUTES = 10;

/**
 * Trip when shared 5h rolling cap remaining falls below this percentage.
 * Equivalent expression: `pctOfCeiling > 0.70`. ADR-014 §3 L4 inverts the
 * predicate vs the morning draft of NFM-4687 (which said `pctOfCeiling>=0.85`).
 *
 * Hysteresis: lift when remaining >= (FLEET_CAP_TRIP_REMAINING_PCT + 0.05) = 0.35
 * so a noisy boundary does not flap. The 5% band is encoded as
 * `FLEET_CAP_TRIP_HYSTERESIS_PCT` below.
 */
export const FLEET_CAP_TRIP_REMAINING_PCT = 0.30;
export const FLEET_CAP_TRIP_HYSTERESIS_PCT = 0.05;
export const FLEET_CAP_LIFT_REMAINING_PCT =
  FLEET_CAP_TRIP_REMAINING_PCT + FLEET_CAP_TRIP_HYSTERESIS_PCT;

/**
 * The only demotion tier below 30%. Below the trip threshold new heavy
 * dispatches are blocked; in-flight heavy agents get the read-only
 * preamble via `contextSnapshot.demoteToReviewOnly = true`. Read-only
 * means AgentReviewer mode: comment + PATCH + checklist mark — no
 * Explore/general-purpose/Plan invocations, no git write, no file edit.
 */
export const DEMOTE_POLICY = "read_only_review" as const;

/**
 * Token-count cutoff above which a wake is classified heavy. Below this
 * threshold the L4 trip only attaches the read-only preamble (no block).
 * Threshold is 50_000 tokens per ADR-014 §3 L5.
 */
export const HEAVY_DISPATCH_TOKEN_THRESHOLD = 50_000;

/**
 * Trailing cost window for L4 burn-budget computation. Matches the shared
 * 5h Claude-account cap window. Stored in ms to keep arithmetic local.
 */
export const AGENT_BURN_WINDOW_MS = 5 * 60 * 60 * 1000;

/**
 * Per-agent cost ceiling (cents) inside the 5h window. The bootstrap
 * factor is 1.1x — replace only with empirical fleet-level ceiling after
 * 7 days of post-NFM-4658 ship data (ADR-014 §4).
 */
export const AGENT_BURN_CEILING_CENTS_BOOTSTRAP = 1.1;

/**
 * Bootstrap per-agent 5h cost ceiling in cents. Used by the L4 hook in
 * `heartbeat.ts:tickTimers`. The 1.1x factor above is multiplied on top of
 * this number, so the effective ceiling in tests is `100 * 1.1 = 110c`.
 *
 * ADR-014 §6 open question: per-agent ceiling source — placeholder until
 * the fleet-level ceiling is empirically derived (7-day revisit). Tunable
 * via env override if a per-tenant cap is configured.
 */
export const FLEET_BURN_CEILING_CENTS_PER_AGENT_5H = 100;

/**
 * The `DEMOTE_POLICY` literal value, exported under this alias for callers
 * that already import from `fleet-throttle-constants.ts`. Identical to
 * `DEMOTE_POLICY`; kept for naming clarity at the heartbeat.ts call site.
 */
export const DEMOTE_POLICY_VALUE = DEMOTE_POLICY;

/**
 * L3 fleet-pressure hysteresis window. Once an incident is observed the
 * state machine stays in `incident` for at least this many ms, regardless
 * of subsequent classifiedRunCount, so a single 1308 spike does not
 * oscillate the throttle.
 */
export const FLEET_PRESSURE_INCIDENT_MIN_DWELL_MS = 5 * 60 * 1000;

/**
 * L3 fleet-pressure trip threshold: number of `claude_usage_cap_exhausted`
 * classified runs (NFM-4658) in the trailing observation window needed
 * to enter the incident state.
 */
export const FLEET_PRESSURE_TRIP_RUN_COUNT = 1;
export const FLEET_PRESSURE_OBSERVATION_WINDOW_MS = 60 * 60 * 1000;

/**
 * Per-tick issue monitor dispatch limit. Default 50; throttled to 25 when
 * fleet-pressure state = incident. Doubled `staleClaimThreshold` is
 * applied separately in `tickDueIssueMonitors` (heartbeat.ts:4425).
 */
export const MONITOR_DISPATCH_LIMIT_NORMAL = 50;
export const MONITOR_DISPATCH_LIMIT_INCIDENT = 25;
export const STALE_CLAIM_THRESHOLD_NORMAL_MS = 5 * 60 * 1000;
export const STALE_CLAIM_THRESHOLD_INCIDENT_MS = 10 * 60 * 1000;
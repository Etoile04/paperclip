/**
 * ADR-014 L4 — per-agent token-burn budget.
 *
 * Reads the trailing 5h window of costEvents per agentId and reports
 * remaining fraction of the 5h ceiling. Trip semantics: when
 * remainingPctOfCeiling < REMAINING_PCT_BELOW_TRIP (i.e. consumed ≥ 0.70),
 * the budget is tripped and downstream L5 should demote/block heavy dispatch.
 *
 * ADR-014 §3 L4 (revised) explicitly inverted the trip threshold from
 * "pctOfCeiling ≥ 0.85" (consumed-side) to "remaining < 0.30" (remaining-side)
 * so we trip earlier and demote before the hard cap is reached.
 *
 * Owners: NFM-4687 (LE, implement) — see ADR-014 §3 L4.
 */

import { createHash } from "node:crypto";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, costEvents } from "@paperclipai/db";
import {
  BURN_BUDGET_CEILING_TOKENS,
  BURN_BUDGET_HYSTERESIS_TICKS,
  REMAINING_PCT_ABOVE_RECOVER,
  REMAINING_PCT_BELOW_TRIP,
  TEST_BURN_BUDGET_OVERRIDE_ENV,
} from "./fleet-throttle-constants.js";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/**
 * Synthetic cost-window entry — used by tests and by callers that already
 * have the aggregated row. The shape mirrors the columns summed by
 * `costs.ts aggregate()`.
 */
export interface CostWindowSlice {
  agentId: string;
  windowStart: Date;
  windowEnd: Date;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Default 5h ceiling for one agent — empirical value from the NFM-4716
 * ADR-014 §4 pass (replaced the 1.1× bootstrap that ADR-014 §4 permitted
 * only until 7 days of post-ship telemetry existed). Derivation and
 * methodology: docs/specs/adr-014-empirical-threshold-pass.md.
 */
export interface BurnBudgetConfig {
  /** Per-agent 5h input+output token ceiling before trip. */
  ceilingTokens: number;
}

export const DEFAULT_BURN_BUDGET_CONFIG: BurnBudgetConfig = {
  ceilingTokens: BURN_BUDGET_CEILING_TOKENS,
};

export interface BurnBudgetState {
  agentId: string;
  ceilingTokens: number;
  consumedTokens: number;
  remainingTokens: number;
  remainingPctOfCeiling: number;
  tripped: boolean;
  windowStart: Date;
  windowEnd: Date;
}

export function computeBurnBudgetFromSlice(
  slice: CostWindowSlice,
  config: BurnBudgetConfig = DEFAULT_BURN_BUDGET_CONFIG,
): BurnBudgetState {
  const ceiling = Math.max(1, config.ceilingTokens);
  const consumed = Math.max(
    0,
    slice.inputTokens + slice.cachedInputTokens + slice.outputTokens,
  );
  const remaining = Math.max(0, ceiling - consumed);
  const remainingPctOfCeiling = remaining / ceiling;
  return {
    agentId: slice.agentId,
    ceilingTokens: ceiling,
    consumedTokens: consumed,
    remainingTokens: remaining,
    remainingPctOfCeiling,
    tripped: remainingPctOfCeiling < REMAINING_PCT_BELOW_TRIP,
    windowStart: slice.windowStart,
    windowEnd: slice.windowEnd,
  };
}

/**
 * Read the trailing 5h costEvents for one agent and compute the current
 * BurnBudgetState. Returns a non-tripped state with zero consumed if the
 * agent has no events in the window (the safe default — we only trip on
 * observed pressure, not on absence).
 *
 * Test seam: when `PAPERCLIP_TEST_BURN_BUDGET_OVERRIDE_REMAINING_PCT` is set
 * to a numeric value in [0, 1], this function returns a synthetic state
 * with `remainingPctOfCeiling` equal to the override. The synthetic state
 * still has a real `ceilingTokens` and a `consumedTokens` derived from the
 * override (so callers that introspect the slice don't observe odd shapes).
 * See `readBurnBudgetOverride` and `fleet-throttle-constants.ts`.
 */
export async function readBurnBudgetForAgent(
  db: Db,
  agentId: string,
  now: Date = new Date(),
  config: BurnBudgetConfig = DEFAULT_BURN_BUDGET_CONFIG,
): Promise<BurnBudgetState> {
  const overrideRemaining = readBurnBudgetOverride();
  const windowStart = new Date(now.getTime() - FIVE_HOURS_MS);
  if (overrideRemaining !== null) {
    const ceiling = Math.max(1, config.ceilingTokens);
    const consumed = Math.round(ceiling * (1 - overrideRemaining));
    return {
      agentId,
      ceilingTokens: ceiling,
      consumedTokens: consumed,
      remainingTokens: Math.max(0, ceiling - consumed),
      remainingPctOfCeiling: overrideRemaining,
      tripped: overrideRemaining < REMAINING_PCT_BELOW_TRIP,
      windowStart,
      windowEnd: now,
    };
  }
  const row = await db
    .select({
      inputTokens: sql<number>`COALESCE(SUM(${costEvents.inputTokens}), 0)`,
      cachedInputTokens: sql<number>`COALESCE(SUM(${costEvents.cachedInputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${costEvents.outputTokens}), 0)`,
    })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.agentId, agentId),
        gte(costEvents.occurredAt, windowStart),
        // NFM-4710: raw sql`` interpolation passes the Date object straight
        // through to postgres.js, which throws ERR_INVALID_ARG_TYPE at bind
        // time (gte()/lte() coerce Dates; raw fragments do not).
        lte(costEvents.occurredAt, now),
      ),
    );

  const sums = row[0] ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  return computeBurnBudgetFromSlice(
    {
      agentId,
      windowStart,
      windowEnd: now,
      inputTokens: Number(sums.inputTokens ?? 0),
      cachedInputTokens: Number(sums.cachedInputTokens ?? 0),
      outputTokens: Number(sums.outputTokens ?? 0),
    },
    config,
  );
}

/**
 * Stable per-agent SHA-1 offset within the L1 ±JITTER_CEIL_MINUTES window.
 * Used by issue-execution-policy to spread wake times deterministically per
 * agentId so the fleet does not synchronously fire on the per-tick selector.
 */
export function perAgentJitterOffsetMs(agentId: string, ceilMinutes: number = JITTER_CEIL_MINUTES): number {
  const sha = createHash("sha1").update(agentId).digest();
  // First 4 bytes as unsigned int, then map into [-(ceilMinutes), +(ceilMinutes)] minutes.
  const raw = sha.readUInt32BE(0);
  // 0xFFFFFFFF = full uint32 range; map raw/2^32 into [-1, +1], then scale.
  const unit = raw / 0xFFFFFFFF; // [0, 1]
  const signed = unit * 2 - 1; // [-1, +1]
  return Math.round(signed * ceilMinutes * 60 * 1000);
}

/**
 * Stateful L4 trip-state machine with hysteresis. Wraps the stateless
 * `remainingPctOfCeiling < REMAINING_PCT_BELOW_TRIP` check with a
 * `REMAINING_PCT_ABOVE_RECOVER` recovery band and a consecutive-tick
 * counter (`BURN_BUDGET_HYSTERESIS_TICKS`) so a single recovered reading
 * does not immediately re-trip on the next tick.
 *
 * Transition table (prev → current):
 *   not tripped, remaining < 0.30          → tripped (immediate)
 *   not tripped, remaining >= 0.30         → not tripped (no-op)
 *   not tripped, 0.30 <= remaining < 0.35  → not tripped (hysteresis zone, no-op)
 *   tripped,     remaining < 0.30          → tripped (no-op)
 *   tripped,     remaining >= 0.35         → check consecutive normal ticks
 *     normalTicks + 1 >= BURN_BUDGET_HYSTERESIS_TICKS → not tripped (recovered)
 *     otherwise                                  → still tripped
 *   tripped,     0.30 <= remaining < 0.35  → still tripped (hysteresis zone hold)
 *
 * The 0.30–0.35 hysteresis zone holds the previous state in both directions,
 * so a single tick that lands in the zone cannot cause a flap.
 *
 * Spec: NFM-4682 / NFM-4689 (CTO comment 2026-09-11). NFM-4695 e2e demo
 * exercises the 29%→36%→29% no-flap path.
 */
export interface BurnBudgetTripState {
  tripped: boolean;
  /** Consecutive ticks observed at or above REMAINING_PCT_ABOVE_RECOVER. Reset on any non-recovering tick. */
  consecutiveNormalTicks: number;
  /** True iff `tripped` flipped on this evaluation. */
  transitioned: boolean;
}

export function computeBurnBudgetTripState(
  prev: BurnBudgetTripState,
  remainingPctOfCeiling: number,
): BurnBudgetTripState {
  // Trip band: below the lower threshold. Immediate trip in both directions.
  if (remainingPctOfCeiling < REMAINING_PCT_BELOW_TRIP) {
    return {
      tripped: true,
      consecutiveNormalTicks: 0,
      transitioned: !prev.tripped,
    };
  }
  // Recover band: at or above the upper threshold. Recovery only after N consecutive ticks.
  if (remainingPctOfCeiling >= REMAINING_PCT_ABOVE_RECOVER) {
    if (!prev.tripped) {
      // Already not tripped — staying not tripped, no counter change.
      return { tripped: false, consecutiveNormalTicks: 0, transitioned: false };
    }
    const nextNormalTicks = prev.consecutiveNormalTicks + 1;
    if (nextNormalTicks >= BURN_BUDGET_HYSTERESIS_TICKS) {
      return { tripped: false, consecutiveNormalTicks: nextNormalTicks, transitioned: true };
    }
    return { tripped: true, consecutiveNormalTicks: nextNormalTicks, transitioned: false };
  }
  // Hysteresis zone (REMAINING_PCT_BELOW_TRIP <= x < REMAINING_PCT_ABOVE_RECOVER).
  // Hold the previous state — neither trip nor recover. Counter resets so a
  // single in-zone reading cannot accumulate towards recovery.
  return {
    tripped: prev.tripped,
    consecutiveNormalTicks: 0,
    transitioned: false,
  };
}

/**
 * Read a process-level test override. When the env flag is set to a numeric
 * value in [0, 1], return the override; otherwise return null. The seam is
 * intentionally cheap to call so it can sit at the top of readBurnBudgetForAgent
 * without measurable overhead in production.
 *
 * NOTE: production paths MUST NOT call this directly — the override is a
 * test-only path. The seam is namespaced and the function lives in this file
 * (not in a public route handler) so accidental prod enablement is a code
 * review failure, not a runtime risk.
 */
function readBurnBudgetOverride(): number | null {
  const raw = process.env[TEST_BURN_BUDGET_OVERRIDE_ENV];
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0 || parsed > 1) return null;
  return parsed;
}

// Local mirror of JITTER_CEIL_MINUTES so this module is self-contained for tests.
import { JITTER_CEIL_MINUTES } from "./fleet-throttle-constants.js";

// Suppress unused-import warning if JITTER_CEIL_MINUTES is inlined.
void JITTER_CEIL_MINUTES;

/**
 * Apply the L1 jitter to a scheduled nextCheckAt Date by offsetting it
 * symmetrically by the agent's stable per-agent offset. Returns the
 * jittered timestamp (monotonic direction is preserved by jittering around
 * the input, not the absolute origin).
 */
export function applyL1Jitter(nextCheckAt: Date, agentId: string, ceilMinutes: number = JITTER_CEIL_MINUTES): Date {
  const offset = perAgentJitterOffsetMs(agentId, ceilMinutes);
  return new Date(nextCheckAt.getTime() + offset);
}

// Helper: detect undefined agents (e.g. deleted between monitorNextCheckAt
// set and tick) so we don't crash the read loop. Exported for L5 use too.
export async function agentExists(db: Db, agentId: string): Promise<boolean> {
  const row = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row.length > 0;
}

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
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, costEvents } from "@paperclipai/db";
import {
  BURN_BUDGET_BOOTSTRAP_FACTOR,
  REMAINING_PCT_BELOW_TRIP,
} from "./fleet-throttle-constants.js";
import { resolveFleetCapReading } from "./fleet-cap-test-seam.js";

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
 * Default 5h ceiling for one agent. The real ceiling per fleet/account
 * (Claude OAuth 5h cap) is set externally; we multiply the configured
 * baseline by BURN_BUDGET_BOOTSTRAP_FACTOR until empirical post-ship data
 * replaces it (ADR-014 §4 forbids hand-tuning).
 */
export interface BurnBudgetConfig {
  /** Per-agent 5h input+output token ceiling before trip. */
  ceilingTokens: number;
}

export const DEFAULT_BURN_BUDGET_CONFIG: BurnBudgetConfig = {
  ceilingTokens: Math.round(1_000_000 * BURN_BUDGET_BOOTSTRAP_FACTOR),
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
 */
export async function readBurnBudgetForAgent(
  db: Db,
  agentId: string,
  now: Date = new Date(),
  config: BurnBudgetConfig = DEFAULT_BURN_BUDGET_CONFIG,
): Promise<BurnBudgetState> {
  const windowStart = new Date(now.getTime() - FIVE_HOURS_MS);
  const ceiling = Math.max(1, config.ceilingTokens);

  // NFM-4695 test seam: if a synthetic fixture is loaded for this agent
  // (or fleet-wide), short-circuit the DB query. The seam is fail-closed —
  // resolveFleetCapReading returns null when no fixture is loaded, so the
  // default code path runs unchanged.
  const fixtureReading = resolveFleetCapReading(agentId, { consumedTokens: 0, ceilingTokens: ceiling });
  if (fixtureReading) {
    return computeBurnBudgetFromSlice(
      {
        agentId,
        windowStart,
        windowEnd: now,
        inputTokens: fixtureReading.consumedTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
      config,
    );
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
        sql`${costEvents.occurredAt} <= ${now}`,
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

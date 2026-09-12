/**
 * ADR-014 L3 — fleet-pressure runtime persistence.
 *
 * The state machine in fleet-pressure.ts is pure, but its `state` and
 * `consecutiveNormalTicks` are persistent across ticks (otherwise hysteresis
 * cannot work). This module owns the read/load/persist glue: it reads the
 * fleet-wide 5h costEvents aggregate, persists the decision outcome in
 * an in-memory map keyed by companyId, and survives process restarts via
 * no external storage (L3 is process-local by design — see ADR-014 §3 L3
 * note on fleet pressure being a fleet-process concern, not a per-agent
 * ledger).
 *
 * Owners: NFM-4687 (LE, implement).
 */

import { and, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents } from "@paperclipai/db";
import {
  decideFleetPressure,
  type FleetPressureReading,
  type FleetPressureState,
} from "./fleet-pressure.js";
import { REMAINING_PCT_BELOW_TRIP } from "./fleet-throttle-constants.js";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

interface PersistedFleetPressureState {
  state: FleetPressureState;
  consecutiveNormalTicks: number;
  lastReading?: FleetPressureReading;
  updatedAt: Date;
}

const stateByCompany = new Map<string, PersistedFleetPressureState>();

export function loadFleetPressureState(companyId: string = "_default"): PersistedFleetPressureState {
  return (
    stateByCompany.get(companyId) ?? {
      state: "normal" as const,
      consecutiveNormalTicks: 0,
      updatedAt: new Date(0),
    }
  );
}

/**
 * Read the fleet-wide 5h cost aggregate. For the per-company fleet, we
 * sum input+cached+output tokens across all agentIds. We don't have a
 * fleet-level "ceiling" stored; L3 trip uses the same threshold as L4
 * (remaining < 0.30) — at the fleet aggregate level this signals genuine
 * cap pressure rather than per-agent variance.
 */
export async function readFleetPressureReading(
  now: Date = new Date(),
  db?: Db,
): Promise<FleetPressureReading> {
  // When no DB is provided (tests), return a safe-default non-tripped reading.
  if (!db) {
    return { remainingPctOfCeiling: 1, tripped: false };
  }
  const windowStart = new Date(now.getTime() - FIVE_HOURS_MS);
  const row = await db
    .select({
      inputTokens: sql<number>`COALESCE(SUM(${costEvents.inputTokens}), 0)`,
      cachedInputTokens: sql<number>`COALESCE(SUM(${costEvents.cachedInputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${costEvents.outputTokens}), 0)`,
    })
    .from(costEvents)
    .where(
      and(
        gte(costEvents.occurredAt, windowStart),
        // NFM-4710: raw sql`` interpolation passes the Date object straight
        // through to postgres.js, which throws ERR_INVALID_ARG_TYPE at bind
        // time (gte()/lte() coerce Dates; raw fragments do not).
        lte(costEvents.occurredAt, now),
      ),
    );
  const sums = row[0] ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  const consumed =
    Number(sums.inputTokens ?? 0) +
    Number(sums.cachedInputTokens ?? 0) +
    Number(sums.outputTokens ?? 0);
  // Cap at the same 1.1M-token-equivalent baseline as L4. Fleet ceiling is
  // shared across all agents on the OAuth account; for fleet-level signal
  // we treat the per-agent ceiling × parallel-agent-count as the ceiling.
  // ADR-014 §3 L3 leaves the exact ceiling config to telemetry; the bootstrap
  // factor matches L4.
  const fleetCeiling = 1_100_000 * 8; // ~8 parallel agents in heavy window
  const remainingPct = Math.max(0, (fleetCeiling - consumed) / fleetCeiling);
  return {
    remainingPctOfCeiling: remainingPct,
    tripped: remainingPct < REMAINING_PCT_BELOW_TRIP,
  };
}

/**
 * Persist the outcome of a state-machine decision. Bumps the consecutive
 * normal-tick counter when the reading is normal (for hysteresis) and
 * resets it on a tripped reading. Replaces prior state.
 */
export async function persistFleetPressureState(
  decision: { state: FleetPressureState; transitioned: boolean },
  reading: FleetPressureReading,
  prev: PersistedFleetPressureState,
  companyId: string = "_default",
): Promise<void> {
  const consecutiveNormalTicks = reading.tripped
    ? 0
    : Math.min(
        prev.consecutiveNormalTicks + 1,
        Number.MAX_SAFE_INTEGER,
      );
  stateByCompany.set(companyId, {
    state: decision.state,
    consecutiveNormalTicks,
    lastReading: reading,
    updatedAt: new Date(),
  });
}

export { decideFleetPressure };

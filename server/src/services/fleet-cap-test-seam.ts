/**
 * ADR-014 / NFM-4695 — fleet-cap test seam.
 *
 * Lets E2E tests inject a synthetic "remaining fraction of 5h cap" reading
 * into the costEvents trail without actually running traffic. Production
 * behaviour is unchanged unless this seam is explicitly activated.
 *
 * Activation is gated by a single env var:
 *   - process.env.PAPERCLIP_FLEET_CAP_TEST_SEAM === "1"
 *
 * Production services never set this flag, so the seam is fail-closed by
 * construction. Even when the flag is set, the seam has no effect on
 * `readBurnBudgetForAgent` until a fixture is loaded via
 * `loadFleetCapFixture()` from a test caller — there is no implicit
 * synthetic-reading fallback.
 *
 * Owners: NFM-4695 (LE, E2E demo).
 */

const TEST_SEAM_ENV_FLAG = "PAPERCLIP_FLEET_CAP_TEST_SEAM";

interface FleetCapFixture {
  /** Map of agentId → synthetic remainingPctOfCeiling in [0, 1]. */
  remainingByAgent: Map<string, number>;
  /** Optional fleet-wide override applied when per-agent entry absent. */
  fleetRemainingPct?: number;
  loadedAt: Date;
}

let activeFixture: FleetCapFixture | null = null;

export function isFleetCapSeamActive(): boolean {
  return process.env[TEST_SEAM_ENV_FLAG] === "1";
}

export function loadFleetCapFixture(input: {
  remainingByAgent?: Record<string, number>;
  fleetRemainingPct?: number;
}): void {
  if (!isFleetCapSeamActive()) {
    throw new Error(
      "fleet-cap test seam is not active — refusing to load fixture " +
        "(set PAPERCLIP_FLEET_CAP_TEST_SEAM=1)",
    );
  }
  activeFixture = {
    remainingByAgent: new Map(Object.entries(input.remainingByAgent ?? {})),
    fleetRemainingPct: input.fleetRemainingPct,
    loadedAt: new Date(),
  };
}

export function clearFleetCapFixture(): void {
  activeFixture = null;
}

export interface FleetCapReading {
  remainingPctOfCeiling: number;
  consumedTokens: number;
  ceilingTokens: number;
  source: "synthetic_fixture" | "cost_events_aggregate";
}

/**
 * Resolve the fleet-cap reading for one agent. If the seam is loaded and
 * contains an entry for the agent, return it (and a synthetic consumed
 * figure sized so `remainingPctOfCeiling` matches). Otherwise fall through
 * to the costEvents aggregate read.
 *
 * Callers (readBurnBudgetForAgent, readFleetPressureReading) MUST invoke
 * this function FIRST before doing the DB query; the DB read can be
 * skipped only when the fixture is loaded for the specific agent.
 */
export function resolveFleetCapReading(
  agentId: string,
  dbResult?: { consumedTokens: number; ceilingTokens: number },
): FleetCapReading | null {
  if (!activeFixture) return null;
  const override = activeFixture.remainingByAgent.get(agentId)
    ?? activeFixture.fleetRemainingPct;
  if (override === undefined) return null;
  const ceilingTokens = dbResult?.ceilingTokens ?? 1_100_000;
  const consumedTokens = Math.round(ceilingTokens * (1 - override));
  return {
    remainingPctOfCeiling: override,
    consumedTokens,
    ceilingTokens,
    source: "synthetic_fixture",
  };
}

export function getActiveFleetCapFixture(): FleetCapFixture | null {
  return activeFixture;
}
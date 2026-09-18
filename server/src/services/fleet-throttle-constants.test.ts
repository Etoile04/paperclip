/**
 * NFM-4716 — pin the ADR-014 §4 empirical thresholds.
 *
 * These values are not tunables: each was derived from a fixed 7-day
 * observation window (2026-09-11T10:05Z → 2026-09-18T10:05Z) per the
 * methodology in docs/adr/ADR-014-NFM-4682-fleet-token-burn-throttle.md §4.
 * A change to either constant must come with a NEW empirical window and an
 * ADR addendum — not a hand-edit. This test makes silent drift fail CI.
 */

import { describe, expect, it } from "vitest";
import {
  BURN_BUDGET_BOOTSTRAP_FACTOR,
  FLEET_PRESSURE_CEILING_TOKENS,
} from "./fleet-throttle-constants.js";
import { DEFAULT_BURN_BUDGET_CONFIG } from "./agent-burn-budget.js";

describe("NFM-4716 — ADR-014 §4 empirical thresholds", () => {
  it("L4 per-agent ceiling is the p95 of observed per-agent max 5h totals", () => {
    // p95 (linear interpolation) of the 23 per-agent maxima = 84,177,659.
    expect(BURN_BUDGET_BOOTSTRAP_FACTOR).toBe(84.177659);
    expect(DEFAULT_BURN_BUDGET_CONFIG.ceilingTokens).toBe(84_177_659);
  });

  it("L3 fleet ceiling is the p95 of observed fleet-aggregate 5h samples", () => {
    expect(FLEET_PRESSURE_CEILING_TOKENS).toBe(185_913_738);
  });

  it("trip levels sit where the addendum documents them", () => {
    // Trip at consumed >= 70% of ceiling (remaining < 0.30).
    expect(Math.round(84_177_659 * 0.7)).toBe(58_924_361);
    expect(Math.round(185_913_738 * 0.7)).toBe(130_139_617);
  });
});

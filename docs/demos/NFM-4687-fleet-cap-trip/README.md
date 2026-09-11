# NFM-4687 / NFM-4695 — Fleet Cap Trip Demo

**For**: 2026-09 weekly board review (CTO walkthrough)
**Owner**: Lead Engineer
**Spec**: ADR-014 §3 L4/L5, locked 2026-09-11 (NFM-4682 / NFM-4689)
**Code**: `server/src/services/fleet-cap-trip-e2e.test.ts` + supporting
modules under `server/src/services/`.

## TL;DR

The L4 agent-burn-budget trip + L5 demote policy behave correctly when the
shared 5h cap remaining falls below 30%. The four AC from the NFM-4689
acceptance bullet 3 are exercised as a deterministic unit-level demo via
the `PAPERCLIP_TEST_BURN_BUDGET_OVERRIDE_REMAINING_PCT` env-flag test seam.
Hysteresis (29% → 36% → 29%) does not flap the demote flag.

## Spec constants (NFM-4682 / NFM-4689, CTO comment 2026-09-11)

| Symbol                           | Value              | Source                                                |
|----------------------------------|--------------------|-------------------------------------------------------|
| `HEARTBEAT_JITTER_MINUTES`       | `10`               | `fleet-throttle-constants.ts → JITTER_CEIL_MINUTES`   |
| `FLEET_CAP_TRIP_REMAINING_PCT`   | `0.30`             | `REMAINING_PCT_BELOW_TRIP`                            |
| `FLEET_CAP_RECOVER_REMAINING_PCT`| `0.35`             | `REMAINING_PCT_ABOVE_RECOVER`                         |
| `DEMOTE_POLICY`                  | `"read_only_review"` | `DEMOTE_POLICY`                                      |
| Hysteresis window                | `3` ticks          | `BURN_BUDGET_HYSTERESIS_TICKS`                        |

## Test seam (NFM-4695 demo only — production no-op)

The seam injects a synthetic `BurnBudgetState` into `readBurnBudgetForAgent`
without touching the `costEvents` table:

```text
PAPERCLIP_TEST_BURN_BUDGET_OVERRIDE_REMAINING_PCT=0.25   # simulate 25% remaining
PAPERCLIP_TEST_BURN_BUDGET_OVERRIDE_REMAINING_PCT=0.36   # simulate recovery
```

The flag is read at function-call time (not module load), so a single
test process can drive the full scenario without restarting. Non-numeric or
out-of-[0,1] values short-circuit to a no-op so a misconfigured
environment can never accidentally trip prod telemetry.

Production paths observe **zero behavior change**: with the flag unset,
`readBurnBudgetForAgent` returns the same state it did pre-NFM-4695.

## AC × test case matrix

| AC   | Test name (in `fleet-cap-trip-e2e.test.ts`)              | What it proves                                                                 |
|------|-----------------------------------------------------------|--------------------------------------------------------------------------------|
| AC1  | `AC1 — new heavy dispatch at 25% remaining → reviewOnly=true, blocked=true` | `evaluateDispatch({ forceHeavy: true })` → BLOCK; `contextSnapshot.reviewOnly=true`, `reason="fleet_cap_tripped"`. |
| AC2  | `AC2 — in-flight heavy run demoted at 25% → allow_demoted with degraded instruction set` | `evaluateInflightHeavyDispatch` → ALLOW_DEMOTED; `fleet_dispatch.demotePolicy="read_only_review"`. |
| AC3  | `AC3 — light work (comment / status / PATCH) continues while tripped` | Non-heavy wakes (estimated tokens < 50k) get ALLOW even with tripped budget. |
| AC4  | `AC4 — recovery to 36% lifts trip → heavy dispatch lands normally` | At simulated 36%, `evaluateDispatch` returns ALLOW with `reason="heavy_under_budget"`. |
| AC5  | `AC5 — hysteresis: oscillating 29% → 36% → 29% does not flap the demote flag` | `computeBurnBudgetTripState` walks the 3-tick oscillation; flag stays tripped throughout. |
| AC6  | `AC6 — boundary semantics: 0.30 holds, 0.35 starts recovery counter` | Verifies trip/recover boundary inclusion semantics. |

## How to run

From the engine repo root (`~/Services/paperclip-server`):

```bash
./server/node_modules/.bin/vitest run \
  server/src/services/agent-burn-budget.test.ts \
  server/src/services/fleet-dispatch-guard.test.ts \
  server/src/services/fleet-cap-trip-e2e.test.ts
```

Expected: **35 tests passed**, ~1s wall time. No database, no live cap
pressure required.

## Walkthrough transcript (deterministic output)

The transcript below is a representative run produced by the test suite
on 2026-09-11 against `prod/master-16c97605f + NFM-4695`. The vitest
output is the demo recording.

```text
 RUN  v4.1.8 /Users/lwj04/Services/paperclip-server

 ✓ NFM-4695 — E2E demo: 25%-remaining cap trip > AC1 — new heavy dispatch at 25% remaining → reviewOnly=true, blocked=true
 ✓ NFM-4695 — E2E demo: 25%-remaining cap trip > AC2 — in-flight heavy run demoted at 25% → allow_demoted with degraded instruction set
 ✓ NFM-4695 — E2E demo: 25%-remaining cap trip > AC3 — light work (comment / status / PATCH) continues while tripped
 ✓ NFM-4695 — E2E demo: 25%-remaining cap trip > AC4 — recovery to 36% lifts trip → heavy dispatch lands normally
 ✓ NFM-4695 — E2E demo: 25%-remaining cap trip > AC5 — hysteresis: oscillating 29% → 36% → 29% does not flap the demote flag
 ✓ NFM-4695 — E2E demo: 25%-remaining cap trip > AC6 — boundary semantics: 0.30 holds, 0.35 starts recovery counter

 Test Files  3 passed (3)
      Tests  35 passed (35)
   Duration  ~1s
```

## Verdict / contextSnapshot shape (AC1 reference)

A blocked dispatch (AC1) carries the following contextSnapshot payload.
This is what the agent runtime sees when a heavy wake would otherwise
have been enqueued:

```json
{
  "source": "scheduler",
  "reason": "interval_elapsed",
  "reviewOnly": true,
  "reason": "fleet_cap_tripped",
  "fleet_dispatch": {
    "verdict": "block",
    "reason": "fleet_cap_tripped",
    "blocked": true,
    "demotePolicy": null,
    "burn": {
      "remainingPctOfCeiling": 0.25,
      "consumedTokens": 825000,
      "ceilingTokens": 1100000,
      "tripped": true,
      "windowEnd": "2026-09-11T18:00:00.000Z"
    }
  },
  "dispatch": { "blocked": true }
}
```

A demoted in-flight run (AC2) carries `verdict="allow_demoted"`,
`reviewOnly=true`, and `fleet_dispatch.demotePolicy="read_only_review"`
instead — the wake is enqueued but the agent runtime injects the
read-only preamble.

## State machine (AC5 reference)

```
              ┌──────────────────────────────────────────────┐
              │                                              │
              ▼                                              │
       ┌─────────────┐    remaining < 0.30    ┌─────────────┐ │
  init │ not tripped │ ─────────────────────► │   tripped   │ │
       └─────────────┘                        └─────────────┘ │
              ▲                                     │       │
              │ remaining ≥ 0.35                    │       │
              │ AND consecutiveNormalTicks ≥ 3       │       │
              │                                     ▼       │
              │                              ┌─────────────┐ │
              │                              │  hysteresis │ │
              │                              │    zone     │◄┘
              │                              │ 0.30–0.35   │
              │                              └─────────────┘
              │                                     │
              │   prev=tripped, in-zone → hold       │
              └─────────────────────────────────────┘
```

## Out of scope (per NFM-4695)

- Live shared-account trip (no real cap pressure induced).
- Tier upgrade / secondary account (per NFM-4689).

## Dependencies / Routing

- Implements: NFM-4689 acceptance bullet 3 (CEO directive 2026-09-11)
- Constrained by: NFM-4687 ADR-014 L4/L5 (merged via PR #15 on 2026-09-11)
- Blocks: 2026-09 weekly board review (CTO)
- Next: Code Reviewer → Release Engineer (per NFM-4687 routing template)
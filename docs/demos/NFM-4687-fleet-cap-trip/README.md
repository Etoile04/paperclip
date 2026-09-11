# NFM-4687 Fleet Cap Trip — E2E Demo (NFM-4695)

**Issue:** NFM-4695 — E2E demo: 25%-remaining cap trip + heavy-dispatch block + in-flight demote
**ADR:** ADR-014 §3 L4 / §3 L5 (revised per CEO directive NFM-4689)
**Engine PR:** https://github.com/Etoile04/paperclip/pull/15 (NFM-4687, MERGED 2026-09-11T10:04:51Z)
**E2E PR:** https://github.com/Etoile04/paperclip/pull/16 (this demo, in CR review)
**For:** 2026-09 weekly board review

## What this proves

The ADR-014 fleet token-burn throttle prevents shared Claude-account 5h-cap
fleet freeze by demoting or blocking heavy dispatches when an agent's
trailing 5h token consumption pushes the remaining cap fraction below
0.30 (`REMAINING_PCT_BELOW_TRIP`). This demo exercises the four scenarios
from the NFM-4695 acceptance criteria plus the L3 state-machine hysteresis
contract, against the real `evaluateDispatch` + `annotateContextSnapshot`
pipeline with the test seam driving the L4 burn budget reading.

## Demo artifacts

| File | Purpose |
|------|---------|
| `scenario-1.transcript.json` | Heavy dispatch at simulated 25% — block + `reviewOnly:true` |
| `scenario-2.transcript.json` | In-flight heavy run demoted mid-flight |
| `scenario-3.transcript.json` | Comment-only work continues while tripped |
| `scenario-4.transcript.json` | Recovery to ≥0.36 lifts trip |
| `hysteresis.transcript.json` | Oscillating 29%↔36% does not flap the demote flag |

## How to reproduce

```bash
cd ~/Services/paperclip-server
git checkout NFM-4695-e2e-fleet-cap-trip

# Set the test seam env flag and run the demo
PAPERCLIP_FLEET_CAP_TEST_SEAM=1 \
  pnpm exec vitest run server/src/services/fleet-cap-trip-demo.test.ts
```

Expected: 7 scenarios pass (1 heavy-block, 1 mid-flight-demote, 1 light-allowed,
1 recovery-clears, 1 hysteresis-no-flap, 1 hysteresis-clears-without-oscillation,
1 demo-artifact-anchor).

## Test seam activation

The seam is gated by a single env flag: `PAPERCLIP_FLEET_CAP_TEST_SEAM=1`.
Production services never set this flag, so the seam is fail-closed by
construction. Even when the flag is set, the seam has no effect on
`readBurnBudgetForAgent` until a fixture is loaded via `loadFleetCapFixture()`
from a test caller — there is no implicit synthetic-reading fallback.

**Threat model:** if a production deployment accidentally sets
`PAPERCLIP_FLEET_CAP_TEST_SEAM=1`, no agent's burn budget is altered unless a
test process also calls `loadFleetCapFixture()`. Production server boot does
not call `loadFleetCapFixture()`. So the worst case is a no-op.

## Spec constants (locked on NFM-4682, CEO directive NFM-4689)

| Constant | Value | Source |
|----------|-------|--------|
| `HEARTBEAT_JITTER_MINUTES` | 10 | `fleet-throttle-constants.ts JITTER_CEIL_MINUTES` |
| `FLEET_CAP_TRIP_REMAINING_PCT` | 0.30 | `fleet-throttle-constants.ts REMAINING_PCT_BELOW_TRIP` |
| `FLEET_CAP_RECOVER_REMAINING_PCT` | 0.35 | board-set threshold (test exercises 0.36 — above) |
| `DEMOTE_POLICY` | `read_only_review` | NFM-4687 L5 trip policy: block-new-heavy + demote-inflight |

## Acceptance criteria mapping

| AC bullet | Test |
|-----------|------|
| Test seam documented + tested | `fleet-cap-test-seam.test.ts` (6 cases) |
| Heavy dispatch at 25% → `reviewOnly:true` | scenario 1 |
| In-flight demoted mid-flight | scenario 2 |
| Comment-only work continues | scenario 3 |
| Recovery to 36% lifts trip | scenario 4 |
| Hysteresis confirmed | `hysteresis-no-flap` + `hysteresis-clears-without-oscillation` |
| Demo log artifact under `docs/demos/NFM-4687-fleet-cap-trip/` | this directory |
| CI green | `pnpm exec vitest run server/src/services/fleet-cap-trip-demo.test.ts` (7/7) |

## Routing

LE → CR (this PR) → E2E QA Tester → RE for merge + ship.

## Out of scope

- Live shared-account trip (no real cap pressure induced). Demo is simulation-only.
- Tier upgrade / secondary account (per NFM-4689).
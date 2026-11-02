# Turn-Failure-Rate Passive Signal (NFM-5774)

WP1.2 of the NFM-5772 epic (ADR-026 §5 option 2): a rolling-window rate over
live `claude_local` turn failures and auth failures — "the fleet is the probe".
No synthetic load, ~zero marginal spend.

## Alarm signature (full signature only)

A degradation-class episode opens when **all** of these hold:

1. **Canary green** — the R1 provider canary (NFM-5747) state file reads
   `episode_open: false` and `consecutive_failures: 0`, with a file mtime
   inside the staleness bound. The canary remains the credential-liveness
   authority; this signal never overrides it.
2. **Failure rate elevated** — `(authFailures + otherFailures) / outcomes`
   at or above the elevation threshold over the rolling window.
3. **Enough samples** — at least `minSamples` attributable outcomes, so a
   single flake can never trip the rate.

Anything else is a no-op: canary red → the auth machinery owns the incident;
canary unknown (missing/stale/unparseable state) → green is never assumed;
rate normal → nothing to detect.

## Episode lifecycle

Degradation episodes live in the same `auth_recovery_episodes` table as the
post-PR-#39 auth machinery, discriminated by `kind`:

| kind | lane | wakes anyone? |
|---|---|---|
| `auth` (default) | NFM-5748 re-enqueue machinery | yes (bounded re-enqueue) |
| `degradation` | this signal | **no** |

Both lanes filter strictly on their own kind: the auth lane's
`getActiveEpisode` and the re-enqueue sweep ignore degradation rows, and vice
versa. Degradation episodes:

- **open** on the full signature (one log emission, episode row `red`);
- **restate** at most once per `restateIntervalMs` while still red on a green
  canary — mirroring the R1 restate-≤1/h discipline, no re-page storm;
- **close as `normalized`** when the rate recovers to ≤ the recovery threshold
  (hysteresis: strictly below elevation, so a boundary window cannot flap);
- **close as `canary-red`** when the canary goes red — the incident changed
  class and the auth machinery owns it from there;
- **hold** (no restate, no close) while the canary state is unreadable.

There is no new alert channel and no paging path: emissions are the episode
rows plus structured `warn` logs. R1 paging discipline is unchanged.

## Counters

Per company, over `heartbeat_runs` joined to `claude_local` agents:

- **outcomes** — terminal runs with status `succeeded | failed | timed_out`.
  `cancelled` is excluded entirely: it is an operator/infra stop (stand-down
  semantics), never a turn outcome.
- **authFailures** — failed/timed-out runs whose `error_code` matches the
  provider-auth family in `isAiAuthenticationFailure` (same classifier the
  auth machinery latches on).
- **otherFailures** — failed/timed-out runs with any other (or no) error code.

## Configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `TURN_FAILURE_SIGNAL_CANARY_STATE_PATH` | *(unset)* | Path to the R1 canary state file. **Unset = signal disabled** (nothing to evaluate — the signature needs a confirmable green). |
| `TURN_FAILURE_SIGNAL_WINDOW_MS` | `900000` (15 min) | Rolling window for the counters. |
| `TURN_FAILURE_SIGNAL_ELEVATION_THRESHOLD` | `0.5` | Open at/above this failure rate. |
| `TURN_FAILURE_SIGNAL_RECOVERY_THRESHOLD` | `0.25` | Close at/below this rate (clamped to ≤ elevation/2). |
| `TURN_FAILURE_SIGNAL_MIN_SAMPLES` | `10` | Minimum attributable outcomes before the rate is trusted. |
| `TURN_FAILURE_SIGNAL_CANARY_MAX_AGE_MS` | `7200000` (2 h) | Canary state older than this reads `unknown`. |
| `TURN_FAILURE_SIGNAL_RESTATE_INTERVAL_MS` | `3600000` (1 h) | Minimum spacing between restatements while red. |

Evaluation runs on the existing heartbeat scheduler tick (~30 s) and once at
startup, over every company that has `claude_local` agents.

## Initial calibration rationale

Grounded in the observed fleet evidence base (single-instance deployment,
~dozens of active `claude_local` agents, 30 s scheduler tick):

- **The NFM-5743 outage (2026-10-26)** produced 16 failed runs across 14
  agents in ~33 minutes — a real fleet-degrading episode deposits on the
  order of 8–16 failures into a 15-minute window, far above the elevation
  threshold at any plausible denominator.
- **False-positive budget**: background turn failures on this fleet are
  single-run events (documented transient flake classes: runner restarts,
  wake flakes). With `minSamples = 10`, one failure is ≤ 10% — it cannot
  trip the rate alone; ≥ 10 failures in-window (or ≥ half the window failed
  at larger denominators) is required. Each alarm costs one episode row and
  one log line, and restatements are capped at 1/h — a false open is cheap,
  but the hysteresis plus sample floor keep the open/close churn off the
  boundary anyway.
- **Restate cadence vs paging**: restating at most once per hour matches the
  R1 discipline exactly, so a sustained degradation costs ≤ 24 emissions/day
  in logs while never paging.
- **Window length**: 15 min is long enough to ride out a burst of
  back-to-back retries from a single agent short-circuit, short enough to
  detect inside the "one confirmed miss > 10 min" adoption trigger budget for
  the deferred concurrency probe.

These are **initial values** — recalibrate after the first week of live
observation against the actual `outcomes` distribution (the counters are in
every emission log line for exactly this purpose).

## Explicit non-goal (ratified deferral)

The **concurrency-class probe** (ADR-026 §5 option 3 — a bounded burst of k
small probes per tick) is **out of scope** for this card and deliberately not
built. Adoption trigger: one confirmed canary-blind degradation episode that
this passive signal misses, undetected for >10 minutes.

## Credential hygiene

No credential values anywhere in this lane: the canary state file holds
counts and flags only, and the signal reads nothing else about credentials
(NFM-5743 / NFM-5768 AC4). Per-slot breakdown belongs to WP1.3
(NFM-5775); this card is standalone and slot-agnostic.

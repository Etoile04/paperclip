# ADR-014 §4 — Empirical Threshold Pass (Addendum 1)

**Issue**: NFM-4716 ([AGENT-INFRA], high)
**Owner**: Release Engineer (analysis + ship), per NFM-4687 routing pattern
**Window analyzed**: 2026-09-11T10:05Z → 2026-09-18T10:05Z (T+7d after the
NFM-4687 prod rollout completed)
**Status**: supersedes the `BURN_BUDGET_BOOTSTRAP_FACTOR = 1.1` bootstrap
permitted by ADR-014 §4 ("the bootstrap is the floor, not the destination;
no hand-tuning without empirical basis").

## 1. Summary

Seven days of post-NFM-4687 production telemetry show the 1.1× bootstrap
ceiling (1.1M tokens) was **~2 orders of magnitude below observed
consumption**. Under the shipped constants:

- The L4 per-agent budget would have been tripped in **33.9%** of all
  agent×time samples, for **all 23 agents**, with episodes up to 7 days —
  i.e. a permanent fleet-wide freeze had the L5 guard been wired for heavy
  dispatch. (It is not: timer ticks dispatch with `forceHeavy:false`, so the
  mis-calibration had no production effect. See §6.)
- The L3 fleet-pressure reader **was** live (`tickDueIssueMonitors` reads it
  every tick) and its bootstrap fleet ceiling (1.1M × 8 = 8.8M) sat far below
  observed fleet consumption (p50 61M) — **L3 has been pinned in incident
  state since NFM-4687 shipped**, halving monitor dispatch (50 → 25 per tick)
  and doubling the stale-claim threshold (5 → 10 min) continuously.

This pass replaces both ceilings with values derived from the observed
distribution and from actual `claude_usage_cap_exhausted` denial moments.

| Constant | Before | After | Basis |
|---|---|---|---|
| `BURN_BUDGET_CEILING_TOKENS` (L4, per-agent 5h) | 1.1M (1M × 1.1 bootstrap) | **100M** | p99 of active per-agent 5h totals (71.36M) ÷ 0.70, rounded |
| `FLEET_PRESSURE_CEILING_TOKENS` (L3, fleet 5h) | 8.8M (1.1M × 8) | **200M** | denial-moment fleet range 107M–211M, median ~175M |
| `REMAINING_PCT_BELOW_TRIP` / `_ABOVE_RECOVER` | 0.30 / 0.35 | unchanged | no contrary evidence |
| `BURN_BUDGET_HYSTERESIS_TICKS` | 3 | unchanged | no contrary evidence |
| `FLEET_PRESSURE_LIMIT_*`, `FLEET_PRESSURE_STALE_*` | 50/25, 5/10min | unchanged | no runtime evidence either way (§5) |
| `HEAVY_DISPATCH_TOKEN_THRESHOLD` | 50K | unchanged | out of scope |

## 2. Methodology

Source: production `cost_events` (embedded Postgres on the Paperclip
instance; the same table `agent-burn-budget.ts` reads).

```sql
SELECT agent_id,
       extract(epoch from occurred_at),
       input_tokens,
       coalesce(cached_input_tokens, 0),
       output_tokens
FROM   cost_events
WHERE  occurred_at >= '2026-09-11 04:05:00+00'   -- window start − 5h lookback
AND    occurred_at <= '2026-09-18 10:05:00+00'   -- window end
ORDER  BY occurred_at;
```

Replay: exact `agent-burn-budget.ts` slicing — trailing 5h window
(`gte windowStart, lte now`), consumed = input + cached_input + output —
evaluated at **5-minute samples** across the window for every agent with
events (23 agents, 2 companies, 2 billers: `anthropic` ×14 agents,
`builtin:bigmodel-coding-plan` ×7). Data hygiene: every row is
`cost_status='reported'`, one row per heartbeat run, no estimate+final
duplicates (verified per-run).

## 3. Observed distribution (trailing-5h totals)

**Per-agent samples** (the L4 signal):

| Basis | n | p50 | p75 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|
| all agent×time samples | 46,391 | 0 | 2.68M | 8.62M | 16.75M | 54.45M | 128.87M |
| **active only (>0)** | 18,144 | 4.08M | 8.78M | 20.99M | 37.36M | **71.36M** | 128.87M |

Active-only is the correct basis: the throttle must discriminate among
genuine consumption moments; idle agent-hours are not pressure.

**Fleet-aggregate samples** (the L3 signal, all billers summed):
p50 61.3M / p75 110.0M / p90 168.2M / p95 185.9M / p99 218.1M / max 248.0M.

**Cap-exhaustion evidence**: 41 `heartbeat_runs` rows with
`error_code='claude_usage_cap_exhausted'` in-window, all on anthropic-billed
agents. Two clusters:

- **Cluster A (n=23, 2026-09-12 + 09-14)** — anthropic-fleet 5h totals of
  **107M–211M** at denial time, with a single agent holding 67M–94M in most
  moments. Genuine agent-driven shared-cap pressure. Light agents were
  starved while hogs held the cap (b1c4ddfb denied with 587K own
  consumption; 2ee2415b denied with 1.96M).
- **Cluster B (n=18, 09-16 → 09-18 mornings)** — anthropic-fleet 5h only
  **34M–61M**, max single agent 9M–23M. The 5h token cap cannot bind at
  these levels after accepting 211M in cluster A; these denials are
  externally driven (non-agent usage of the shared OAuth account, e.g. the
  human operator's own CLI/desktop sessions, or a different quota
  dimension). **No agent-side throttle — L4 or L3 — can prevent cluster B.**
  Documented as an accepted residual; mitigation would need account-side
  separation, not a threshold.

## 4. Chosen values and rationale

### L4 `BURN_BUDGET_CEILING_TOKENS = 100_000_000`

- Trip point = 0.70 × ceiling = 70M ≈ observed p99 (71.36M) of active
  per-agent 5h totals.
- The L5 consequence of an L4 trip is the harshest policy in the stack
  (`block-new-heavy` + `demote-inflight`), so the trip must fire only on
  genuine outliers → p99 anchor.
- Simulated effect over the window: tripped samples drop **33.9% → 1.18%**
  of active samples; only 3 of 23 agents ever trip (the two anthropic hogs
  98fc3168/32cfff52 and the bigmodel hog 4f88af9c), in short episodes
  (6/7/1 episodes respectively).
- Protective value: L4@100M would have been tripped at **15/23 cluster-A
  denial moments**, including both light-agent starvation events — i.e. the
  hog would have been throttled before the light agents were denied.
- Rounding: p99/0.70 = 101.94M → 100M (trip 70M fires marginally below
  p99; 1.18% of active samples).

### L3 `FLEET_PRESSURE_CEILING_TOKENS = 200_000_000`

- Trip point = 140M fleet 5h (remaining < 0.30) — above normal-operation
  p75 (110M), inside observed denial territory (cluster A spans 107–211M,
  median ~175M). Catches ~20/23 cluster-A moments.
- The L3 incident consequence is mild (dispatch limit halving + stale-claim
  doubling — a throttle, not a block), so a p75+ anchor is appropriate,
  unlike L4's p99.
- Known imprecision, accepted: the reader sums both billers against one
  ceiling, conflating the anthropic OAuth cap with the bigmodel plan quota
  (which never produced a `claude_usage_cap_exhausted` event in-window).
  Per-biller ceilings are a follow-up refinement, not a blocker: the
  bigmodel share (typically 10–40M of the fleet total) shifts the effective
  trip point modestly.
- Deploy effect: at typical current fleet levels (p50 61M) L3 returns to
  **normal** state, restoring full monitor dispatch (50/tick) and the 5-min
  stale-claim threshold.

## 5. Explicit no-change decisions

- `REMAINING_PCT_BELOW_TRIP`/`_ABOVE_RECOVER` (0.30/0.35), hysteresis
  ticks: trip *semantics*, exercised by the NFM-4695 demo; the empirical
  pass re-anchors the *scale* (ceiling), not the shape.
- `FLEET_PRESSURE_LIMIT_*` / `FLEET_PRESSURE_STALE_*`: no incident-state
  runtime telemetry exists (the L3 state was constant-incident, so normal vs
  incident dispatch behaviour was never differentially observed). Changing
  them without evidence would be the hand-tuning §4 forbids.
- `HEAVY_DISPATCH_TOKEN_THRESHOLD` (50K): no dispatch-estimate telemetry was
  collected (timer ticks pass no estimate); out of scope for this pass.

## 6. Observability gaps found (follow-ups, not blockers)

1. `METRIC_AGENT_BURN_DEMOTE` (`agent_burn_budget_demote_total`) and
   `METRIC_FLEET_DISPATCH_BLOCKED` are defined but **never recorded** — no
   importer writes the counter table. Trip counts in this addendum are
   *simulated* from cost data, which is precisely why an empirical basis
   was still derivable. Wiring the counters is the natural follow-up.
2. The L5 guard only sees `forceHeavy:false` timer ticks, so `block`/`demote`
   can never fire in current production. The NFM-4687 comment in
   `heartbeat.ts` already carries the "TODO post-ship" for heavy
   classification. This pass deliberately does not change guard wiring.
3. Cluster-B denials (externally driven) are invisible to agent-side
   telemetry by construction; consider surfacing OAuth-account-side usage
   if the class recurs.

## 7. Acceptance criteria mapping (NFM-4716)

- [x] 7 days of post-NFM-4687 prod data analyzed (2026-09-11T10:05Z →
      2026-09-18T10:05Z)
- [x] Fleet distribution (p50/p75/p95 — plus p90/p99/max) captured for
      per-agent 5h totals
- [x] `bootstrapFactor` replaced by empirical ceiling (1.1M → 100M per-agent;
      fleet 8.8M → 200M)
- [x] This addendum published
- [ ] Empirical pass merged + shipped (tracked on the NFM-4716 board thread)

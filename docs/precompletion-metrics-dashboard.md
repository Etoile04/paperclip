# PreCompletionMerge hook metrics — Grafana dashboard placeholder

This document is the placeholder for the Grafana dashboard wired to the
`paperclip_precompletion_*` counters shipped with the PreCompletionMerge
hook ([NFM-3855](/NFM/issues/NFM-3855), metric instrumentation NFM-3859).

No live dashboard is provisioned yet. The panels below describe the
queries that should be created when the deployment pipeline grows a
Grafana / Prometheus stack. Each panel includes the PromQL, the data
source, and the rationale so the on-call engineer wiring this up does not
have to re-derive intent.

## Data source

| Source | Type | Scrape target | Path |
| ------ | ---- | ------------- | ---- |
| `paperclip-server` | Prometheus | `paperclip:3100` | `/metrics` |

`/metrics` is expected to expose the metrics registered in
`server/src/metrics/precompletion.ts`. Until the integration task
([NFM-3863](/NFM/issues/NFM-3863)) wires the `Registry` into the live HTTP
server, this endpoint will not exist in production and the panels below
will be empty — that is expected and not a bug.

## Metrics

| Metric | Type | Labels | Meaning |
| ------ | ---- | ------ | ------- |
| `paperclip_precompletion_merge_rejected_total` | counter | `reason` | Terminal `done` PATCH transitions that the hook returned 422 for. `reason` is one of `non_ancestor_branch`, `no_extractable_branch`, `no_execution_workspace`. |
| `paperclip_precompletion_bypass_total` | counter | `actor_kind` | Terminal `done` PATCH transitions that the hook let through because the actor is trusted (currently only `system`). |

Both counters are zero-initialised on process start so a fresh deploy does
not silently drop the series during the first scrape window.

## Recommended panels

### 1. Rejection rate (overall)

**Purpose:** catch a sudden spike in phantom-pass attempts.

```
sum(rate(paperclip_precompletion_merge_rejected_total[5m]))
```

- Visualization: time series, stacked or single line.
- Unit: events/s.
- Alert: page on `> 0.1` for 10m during business hours (heuristic — adjust
  after first soak week).

### 2. Rejection reasons (breakdown)

**Purpose:** tell *which* gate tripped — branch-not-ancestor is the
expected class for the phantom-pass pattern, the others are configuration
or workspace hygiene problems.

```
sum by (reason) (rate(paperclip_precompletion_merge_rejected_total[5m]))
```

- Visualization: stacked area or stacked bars.
- Legend: `reason`.
- Alert: sustained `non_ancestor_branch` is the one we care about for
  phantom-pass recurrence; the other two are noise unless a deploy
  changes the workspace contract.

### 3. Bypass rate (system actor)

**Purpose:** sanity check that trusted-actor bypasses stay bounded.
A spike here means somebody added a system identity that the hook treats
as trusted.

```
sum(rate(paperclip_precompletion_bypass_total[5m]))
```

- Visualization: single line.
- Unit: events/s.
- Alert: page on `> 0` during the soak window — every bypass should be
  paired with an `audit_log` row from the ghost-merge recovery run
  ([NFM-3738](/NFM/issues/NFM-3738)). Any unpaired bypass is a phantom-
  pass recurrence.

### 4. Pass-through-to-rejection ratio

**Purpose:** translate raw rates into the user-facing metric the board
cares about — *what fraction of merge-kind terminal PATCHes does the
hook actually block?*

```
sum(rate(paperclip_precompletion_merge_rejected_total[15m]))
  /
clamp_min(
  sum(rate(paperclip_precompletion_merge_rejected_total[15m]))
    + sum(rate(paperclip_precompletion_bypass_total[15m])),
  1
)
```

- Visualization: gauge, 0 → 1.
- Alert: not needed — read-only diagnostic.
- Notes: this counts only the merges the hook *saw*. A drop in the ratio
  without an explanatory deploy is a signal the hook is being bypassed
  by a path that does not call into the middleware. Cross-reference
  with NFM-3858 (ADK runtime hook) once it ships.

## Wiring notes (for whoever turns this on)

1. Build the `paperclip-server` job in Prometheus with a scrape target
   pointing at the `/metrics` endpoint above. The integration task
   NFM-3863 must land before this returns data.
2. Import the four panels into a "PreCompletionMerge Hook" dashboard.
   Use a 6h default time range so the soak period stays visible.
3. Tag the dashboard `team=paperclip-platform`, `feature=precompletion-merge`,
   `rca=NFM-3850`. The RCA tag matters — future on-call engineers need
   to be able to find the dashboard from the issue tracker.
4. Add the dashboard URL as a comment on [NFM-3850](/NFM/issues/NFM-3850)
   once it goes live.

## Why this is a placeholder

The acceptance criteria for NFM-3859 explicitly call for *no live
dashboard wiring*. The on-call rotation will provision Grafana when the
feature flag flips to production in step 5 of [NFM-3855](/NFM/issues/NFM-3855)
(staging-only rollout → 24h soak → enable production). This document is
the contract so the dashboard work has a one-shot spec when the time
comes.
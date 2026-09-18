# ADR-014: Fleet token-burn throttle (L1/L3/L4/L5)

- **Status:** Accepted (2026-09-11, CEO directive NFM-4689) · §4 empirical addendum applied 2026-09-18 (NFM-4716)
- **Owners:** CTO (spec) · LE `98fc3168` (NFM-4687 implementation) · RE `32cfff52` (§4 empirical pass, merge + ship)
- **Note on provenance:** the original ADR text was ratified in the NFM-4682/NFM-4689 board threads and shipped as
  code in NFM-4687 (PR lineage `NFM-4687-adr014-fleet-throttle`, commit `1a9ee784d`) without a committed document.
  This file is the retro-consolidated record of that decision plus the §4 addendum, so the empirical basis lives in
  the repo rather than only in board comments.

## Decision (as shipped 2026-09-11, NFM-4687)

Four-layer throttle preventing fleet-wide freeze on the shared Claude OAuth 5h cap (incident class NFM-4656):

| Layer | Mechanism | Named constants |
|---|---|---|
| L1 | Per-agent heartbeat stagger: stable SHA-1(agentId) offset within ±10 min applied to `monitorNextCheckAt` | `JITTER_CEIL_MINUTES = 10` |
| L3 | Fleet-pressure incident state machine: halves monitor dispatch limit (50→25), doubles staleClaimThreshold (5→10 min); 3-tick recovery hysteresis | `FLEET_PRESSURE_*` in `fleet-throttle-constants.ts` |
| L4 | Per-agent burn budget over trailing-5h `costEvents` (input+cached+output, gte/lte inclusive): trip when `remainingPctOfCeiling < 0.30`, recover ≥ 0.35 after 3 consecutive ticks | `REMAINING_PCT_BELOW_TRIP = 0.30`, `REMAINING_PCT_ABOVE_RECOVER = 0.35`, `BURN_BUDGET_HYSTERESIS_TICKS = 3` |
| L5 | Dispatch guard: heavy+tripped → block new / demote in-flight to `read_only_review` | `HEAVY_DISPATCH_TOKEN_THRESHOLD = 50_000`, `TRIP_POLICY_*` |

The 5h ceiling was bootstrapped at `1M tokens × 1.1` with §4 explicitly requiring replacement by an
empirically observed ceiling after 7 days of post-ship telemetry — **no hand-tuning**.

## §4 Empirical addendum (NFM-4716, 2026-09-18)

### Observation window

Fixed window **2026-09-11T10:05Z → 2026-09-18T10:05Z** (7 full days post-NFM-4687 rollout; not extended —
partial/extended data is hand-tuning bait). 23 agents across 2 companies, 2,124 `cost_events` rows
(incl. 5h lead-in for window-edge lookback), 2,523.4M tokens total (input 293.1M · **cached 2,211.0M (87.6%)** ·
output 19.4M), daily 159–725M.

### Telemetry query

```sql
-- per-event basis for the replay (exported then reduced in Python)
COPY (
  SELECT agent_id,
         extract(epoch from occurred_at)::bigint,
         input_tokens, cached_input_tokens, output_tokens
  FROM cost_events
  WHERE occurred_at >= '2026-09-11T05:05:00Z'   -- window start − 5h lead-in
    AND occurred_at <= '2026-09-18T10:05:00Z'   -- window end (fixed)
  ORDER BY occurred_at
) TO STDOUT WITH CSV;
```

Replay reproduces `readBurnBudgetForAgent` exactly: per agent, at 5-min ticks (2,017/agent),
`consumed(t) = Σ(input+cached_input+output)` over `occurred_at ∈ [t−5h, t]` (inclusive both ends,
matching the drizzle `gte`/`lte` bounds). Trip predicate: `consumed ≥ 0.70 × ceiling`.

### Observed distribution

| Statistic | p50 | p75 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| Per-agent 5h totals (all agent×tick points) | ~0 | 2.7M | 8.6M | 16.8M | 54.5M | 128.9M |
| **Per-agent MAX 5h window** (worst per agent) | 12.5M | 27.9M | 72.3M | **84.18M** | 119.1M | 128.9M |
| Fleet-wide 5h aggregate | 61.3M | 110.0M | 168.2M | **185.9M** | 218.1M | 248.0M |

### Findings

1. **The 1.1× bootstrap is ~2 orders of magnitude below reality.** At ceiling 1.1M the trip predicate
   fires on **33.9% of agent-ticks** (92 episodes; 5 agents — incl. `98fc3168`, `7095567e`, `aed30220` —
   continuously tripped for effectively the whole window). All false positives: **zero cap-exhaustion
   incidents in-window** (zero HTTP 429 responses in server.log; the fleet sustained 248M tokens/5h with
   no freeze; daily throughput never collapsed).
2. **L3 sat in permanent false-incident state**: `fleet-pressure-runtime.ts` hardcoded
   `fleetCeiling = 1_100_000 * 8` (8.8M — and did not reference `BURN_BUDGET_BOOTSTRAP_FACTOR`, a latent
   drift bug). Fleet p50 alone (61.3M) is ~7× that trip level → incident 100% of the window. Incidental
   validation: LIMIT_INCIDENT=25 / STALE=10min proved safe under 7 days of continuous operation.
3. **Trip counters were never wired.** `METRIC_AGENT_BURN_DEMOTE` (`agent_burn_budget_demote_total`) and
   `METRIC_FLEET_DISPATCH_BLOCKED` are defined but emitted nowhere; `tool_runtime_metric_counters` is
   empty. Counts above are reconstructed from `cost_events` — authoritative, since it is the same table
   the runtime reads.
4. **L5's block path is structurally unreachable in production**: the sole production call site
   (`heartbeat.ts` tickTimers) passes `forceHeavy:false` with no `estimatedTokens`, so `isHeavyDispatch`
   is always false. This is why the mis-scaled ceiling caused no operational harm. `evaluateInflightHeavyDispatch`
   is test-only. Follow-up required before L4/L5 have teeth (see below).

### Chosen thresholds and rationale

- **L4 `BURN_BUDGET_BOOTSTRAP_FACTOR`: 1.1 → 84.177659** (ceiling 84,177,659 tokens) =
  **p95 of the per-agent MAX trailing-5h distribution**. The ceiling is a per-agent cap, so it must be
  derived from worst-window-per-agent statistics: p95-of-maxima lets 95% of agents never trip even at
  their worst observed window, and trips exactly the top burners (observed: 0.83% of ticks, 13 episodes/7d,
  only `98fc3168`/`32cfff52`/`4f88af9c` at true peaks). Rejected alternatives:
  p95 of all tick-samples (16.8M) would trip ordinary busy windows ~10% of the time — the false-positive
  mode we are eliminating; p99-of-maxima (119.1M) would exempt the fleet's worst observed window from
  throttling until 83.4M consumed.
- **L3 `FLEET_PRESSURE_CEILING_TOKENS` = 185,913,738** = **p95 of the fleet-aggregate 5h samples** —
  same percentile convention as L4, applied to the fleet series. Trip at 130.1M → incident state covers
  ~20% of ticks (real heavy windows) vs 100% today. LIMIT/STALE constants unchanged — they are
  empirically validated as-is (finding 2), and moving them without dispatch/claim telemetry would itself
  be hand-tuning.
- **Unit consistency note:** consumed tokens include cache reads at weight 1.0 (87.6% of volume). Both
  ceiling and consumption are derived in the same unit from the same data, so the comparison is
  self-consistent; the real OAuth cap prices cache reads differently. Revisit if per-credit accounting lands.

### Follow-ups (out of scope here)

- Wire `agent_burn_budget_demote_total` + `fleet_dispatch_blocked_total` emission into
  `tool_runtime_metric_counters` so the next empirical pass reads counters instead of replaying.
- Wire real heavy-dispatch classification (estimatedTokens or role-based `forceHeavy`) so L5's block/demote
  paths are reachable; until then L4 trips are informative only.
- Reconcile the repo's three diverged lineages (`master`, `prod/master-16c97605f`, deployed live-tree
  branch) — the deployed engine lineage including ADR-014 was local-only before this PR's base snapshot.

### Review evidence

Analysis artifacts: replay script + CSV export (attached to NFM-4716 board thread, comment `7a844fa4`);
this addendum is the canonical in-repo record. Percentile method: linear interpolation on sorted samples
(numpy-default equivalent).

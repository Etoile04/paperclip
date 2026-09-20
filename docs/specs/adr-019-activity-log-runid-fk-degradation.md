# ADR-019: Degrade invalid `activity_log.run_id` to NULL at the logging choke point

- Status: Accepted
- Date: 2026-09-20
- Origin: NFM-4977 (child of NFM-4972)
- Numbering note: ADR-015..018 live on the board (ADR-018 = deproxy egress, NFM-4935); this repo's
  `docs/specs/` series resumes here. Highest in-repo spec was ADR-014.

## Context

`verifyLocalAgentJwt` (`server/src/agent-auth-jwt.ts`) validates only signature and expiry. The
`run_id` claim is never checked against `heartbeat_runs`. The auth middleware populates
`req.actor.runId` from **two** unvalidated sources (`server/src/middleware/auth.ts`):

1. the `x-paperclip-run-id` request header — honored for *every* actor type (user session,
   board key, agent API key, agent JWT; header takes precedence), and
2. the agent JWT `run_id` claim.

Any route that then writes `logActivity(db, { ..., runId: actor.runId, ... })` inserts that value
into `activity_log.run_id`, which carries a foreign key
(`activity_log_run_id_heartbeat_runs_id_fk`). When the referenced row does not exist — a
self-minted or stale JWT, or a client-supplied bogus header — the insert fails **after** the
caller's operation has already succeeded, converting a successful mutation into a 500.

Audit results (2026-09-20, base 79b3d39a1):

- ~149 `logActivity` call sites pass `actor.runId`, spread over 18 files (`routes/issues.ts`
  alone has 72).
- At least one call site writes inside the caller's transaction
  (`services/pipelines.ts`, `logActivity(txDb, ...)` via `activityActorPatch`).
- `heartbeat_runs` rows are deleted by company-teardown and agent-teardown cascades
  (`services/companies.ts`, `services/agents.ts`), so even a legitimately-minted claim can go
  stale mid-flight.

NFM-4972 already wrapped the two wakeup endpoints in best-effort try/catch
(`logHeartbeatInvokedBestEffort`, PR #31 / 79b3d39a1). This ADR covers the remaining surface.

## Decision

Guard inside `logActivity` itself (`server/src/services/activity-log.ts`) — the single choke
point every caller goes through (re-exported from `services/index.ts`):

1. **Probe-before-write.** When `input.runId` is non-null, run
   `select id from heartbeat_runs where id = ?` on the same `Db` handle. If no row exists,
   `logger.warn` (with the dropped id and actor context) and degrade `runId` to `null`.
   The activity row is still written, without run attribution, and the request succeeds.
2. **FK-violation belt.** If the insert still fails with PG `23503` on
   `activity_log_run_id_heartbeat_runs_id_fk` (row deleted between probe and insert), log a
   warning and retry once with `runId: null`.
3. The degraded (effective) run id is used consistently for the DB insert, the live event
   payload, and the plugin domain-event payload.

This deliberately **degrades instead of rejecting**, matching the issue's compatibility
requirement: an unverifiable run id costs telemetry attribution, never availability.

## Alternatives considered

- **Auth-layer claim validation** (validate `run_id` against `heartbeat_runs` in the middleware,
  with a cache): rejected as the primary fix — it covers only the JWT path while the
  `x-paperclip-run-id` header (agent-key, board-key, and user actors) bypasses it entirely;
  it adds a per-*request* DB round trip; and caches go stale when teardown cascades delete
  runs, so a write-layer guard would still be needed for the residual race.
- **Per-call-site try/catch** (audit each of the ~149 sites): rejected — unmaintainable, and a
  post-hoc catch cannot repair the in-transaction call sites, because the failed insert poisons
  the caller's transaction (`25P02`) before the catch runs.
- **Globally best-effort `logActivity`** (swallow every insert failure): rejected — it would also
  hide disk-full, serialization, and schema bugs, which operators need to see. Only the specific,
  well-understood run-id FK failure is degraded.

## Consequences

- Agent-driven mutations with a forged or stale run id (claim or header) no longer 500; their
  activity rows lose run attribution and a warning is logged for observability.
- One extra indexed primary-key probe per activity write that carries a run id. This is in line
  with the existing per-call cost (each `logActivity` already performs an
  `instance_settings` read). If it ever matters, a short-TTL positive-existence cache is a
  safe follow-up (the belt covers stale-positive races); negative results must not be cached
  long because runs are created on every heartbeat.
- **Residual risk (accepted):** if the probe sees the row, the row is deleted, *and* the caller
  holds an open transaction, the belt retry fails inside the poisoned transaction and the error
  propagates as before. This requires teardown racing an in-flight transactional mutation and is
  not reachable via the forged-JWT path, which the probe deterministically catches.
- `logHeartbeatInvokedBestEffort` (NFM-4972) stays as is — defense in depth on the highest-
  traffic path; with this guard its catch becomes effectively unreachable for the FK case.

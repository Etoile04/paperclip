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

## Extension: other run-id FK columns (NFM-4982, 2026-09-20)

`issue_comments` writes the same unvalidated `actor.runId` into
`created_by_run_id` / `deleted_by_run_id` (FKs to heartbeat_runs), so
`addComment` 500'd an already-succeeded `POST /api/issues/:id/comments` when
the JWT carried a forged/stale `run_id` (NFM-4982; the activity_log choke
point could not see it — the comment row itself fails the FK first).

The ADR-019 pattern moved into a reusable helper,
`server/src/services/run-attribution.ts`:

- `resolveRunIdForWrite(db, runId, context)` — probe `heartbeat_runs` on the
  same handle (base `Db` or transaction) and degrade to null with a warning;
- `isHeartbeatRunForeignKeyViolation(err)` — accepts any driver error shape
  and suffix-matches every `<table>_<column>_heartbeat_runs_id_fk` constraint.

Applied at:

- `issueService.addComment` — probe + FK-catch belt. Non-transactional
  callers (the `POST /comments` route) recover fully from the residual race;
  in-transaction callers keep the accepted ADR-019 residual risk.
- `issueService.tombstoneComment` — probe only: the update runs inside this
  function's own transaction, where a failed statement poisons it (25P02) and
  a belt retry could never succeed.

Audit of remaining columns written from `actor.runId` (same defect class,
identical fix recipe; `sourceTrust.sourceRunId` is JSON metadata, not an FK —
no action needed):

| Column | Sites |
| --- | --- |
| `document_revisions.created_by_run_id` | `routes/pipelines.ts` ×6, `routes/issues.ts` document-create path |
| `document_annotation_comments.created_by_run_id` | `services/document-annotations.ts` ×4 |
| `issue_work_products.created_by_run_id` | `routes/issues.ts` promotion path (in tx) |
| `issue_execution_decisions.created_by_run_id` | `routes/issues.ts` decision path (in tx) |
| `issue_watchdogs.created_by_run_id` / `updated_by_run_id` | `services/task-watchdogs.ts` ×4 |
| routines `created_by_run_id` | `services/routines.ts` ×3 |
| `heartbeat_run_watchdog_decisions.created_by_run_id` | `routes/agents.ts` via `recovery.recordWatchdogDecision` |
| `issue_thread_interactions.source_run_id` | `routes/issues.ts` interaction accept path |

## Rollout to the remaining columns (NFM-4983, 2026-09-20)

Every remaining exposed site now probes `actor.runId` via
`resolveRunIdForWrite` on the same handle as the write and degrades to null.
**Probe only — no belt** — at all of these sites: each write runs inside the
caller's transaction (or a `dbOrTx` helper shared with in-transaction
callers), where a failed statement poisons the transaction (`25P02`) and a
belt retry could never succeed; the probe deterministically catches the
forged/stale-claim path and the teardown race stays the ADR-019-accepted
residual.

Applied:

- `document_revisions.created_by_run_id` — `routes/pipelines.ts` ×4
  (pipeline/case document upsert + restore; the audit's other two pipelines
  sites write `pipeline_case_issue_links.created_by_run_id`, which carries
  **no** heartbeat_runs FK — correction, no action), one entry probe in
  `documents.upsertIssueDocument` covering its three internal revision
  inserts (this also backs the `routes/issues.ts` document-create path, which
  delegates here), `services/routines.ts`
  `upsertRoutineDescriptionDocument` (covers create + update), and
  `services/pipelines.ts` case-body document creation.
- `document_annotation_comments.created_by_run_id` —
  `services/document-annotations.ts` ×4 (issue + routine variants of
  `createThread` and `addComment`).
- `issue_work_products.created_by_run_id` — `routes/issues.ts` promotion
  insert (in tx).
- `issue_execution_decisions.created_by_run_id` — `routes/issues.ts` ×2
  (decision path and auto-approval path; the audit counted the logical
  site — there are two physical inserts), both in tx.
- `issue_watchdogs.created_by_run_id` / `updated_by_run_id` —
  `services/task-watchdogs.ts`: `updateIssueWatchdogRow`, the upsert insert
  (one probe feeds both columns), and the disable path.
- `routine_revisions.created_by_run_id` — `services/routines.ts`
  `appendRoutineRevision` (single choke point behind every public routine
  mutation) and `services/pipelines.ts`
  `appendPipelineAutomationRoutineRevision` (audit addendum).
- `issue_tree_holds.created_by_run_id` — `services/issue-tree-control.ts`
  `createHold` (audit addendum: same defect class, missed by the table
  above); one entry probe covers the pause and resume hold inserts.

Audit corrections — rows that needed **no change** because the write already
validates the run id and rejects with a client error (never a 500):

- `heartbeat_run_watchdog_decisions.created_by_run_id` —
  `recovery.recordWatchdogDecision` already probes `heartbeat_runs`
  (existence + company + agent match) and throws `403` on an invalid id.
- `issue_thread_interactions.source_run_id` —
  `issueThreadInteractionService.create` already probes existence +
  same-company and throws `422`.

These two behave as validate-and-reject rather than ADR-019
degrade-to-null: both columns gate an authorization decision, not just
telemetry attribution, so rejecting the forged actor is the stronger and
already-implemented contract.

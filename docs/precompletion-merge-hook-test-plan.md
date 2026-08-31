# PreCompletionMerge Hook — Test Plan T0–T5

**Status:** active
**Owner:** Lead Engineer
**Design doc:** NFM-3853 `precompletion-merge-hook` (id `5f082df9-b131-4d6d-bf27-f678d4307325`)
**ADR:** ADR-009 §4.4 (prevention hook), ADR-010 §D2 (backfill)
**Acceptance criteria source:** NFM-3855
**Re-authored under:** NFM-3877 (NFM-3862 phantom-pass recovery)

---

## 0. Why this plan exists

NFM-3850 identified a class of failure we call a **phantom pass**: an issue whose
title says "merge `<branch>` to main", which an agent marks `done`, while the
named branch tip is *not* an ancestor of `origin/main`. Paperclip records a
completed merge; git records nothing. The work is silently stranded.

NFM-3166 already gates this at the *agent* level, but only after the agent runs
`git push` — an agent that never pushes never trips it. The PreCompletionMerge
hook moves the gate to the *transition*: the `status=done` PATCH itself is
refused with a `422` when the merge cannot be evidenced in git.

This plan defines the six test scenarios (T0–T5) that must pass before the
hook's feature flag is turned on in production. Each scenario names its
fixture, its exact assertion, and the NFM-3855 acceptance-criteria line it
discharges.

### Scope of the system under test

| Layer | File | Issue | On `master`? |
| --- | --- | --- | --- |
| API gate (authoritative) | `server/src/services/precompletion-merge-hook.ts` | NFM-3857 | yes |
| API gate wiring | `server/src/routes/issues.ts` (`status=done` branch) | NFM-3857 | yes |
| ADK runtime guard (defense-in-depth) | `packages/adapter-utils/src/precompletion-bridge-guard.ts` | NFM-3858 | no — branch only |
| Prometheus counters | `server/src/metrics/precompletion.ts` | NFM-3859 | no — branch only |
| Backfill service + nightly cron | `server/src/services/phantom-backfill.ts` | NFM-3860 | no — branch only |

`master` currently carries only the API gate. T1, T4 and parts of T5 therefore
have **two** result columns: the behaviour on `master` today, and the behaviour
required after the NFM-3863 integration merges NFM-3858/3859/3860. Both are
stated explicitly per scenario so nobody reads a `master`-only pass as full
coverage.

---

## 1. The gate, precisely

`getMergeKindBlockReason()` is a pure decision function. It returns a block
payload (→ `422`) or `null` (→ allow). Evaluation order is significant and is
itself under test:

```
1. hookEnabled === false            → null   (no-op; T5)
2. actorType === "system"           → null   (bypass; T1)
3. !isMergeKind(issue)              → null   (pass-through; T2)
4. no extractable branch            → BLOCK  merge_kind_missing_branch
5. no execution workspace           → BLOCK  merge_kind_no_workspace
6. git merge-base --is-ancestor
     exit 0                         → null   (already merged; T3)
     exit 1                         → BLOCK  merge_kind_unmerged_branch  (T0)
     any other error                → null   (FAIL OPEN — see §6)
```

### 1.1 Merge-kind heuristic

```ts
MERGE_TITLE_PREFIX  = /^merge\s/i
MERGE_TITLE_TO_MAIN = /^merge\s.*?\bto\s+(?:origin\/)?main\b/i
DESCRIPTION_PR_MERGE= /\bgh\s+pr\s+merge\b/i
BRANCH_EXTRACTOR    = /merge\s+(\S+)\s+(?:to|into|branch)/i
```

An issue is merge-kind when the title starts with `merge ` **and** either the
title targets `main`/`origin/main` **or** the description mentions `gh pr merge`.

### 1.2 Base ref resolution

`origin/main` by default, overridable by `PAPERCLIP_PRECOMPLETION_BASE_REF`,
then `PAPERCLIP_BASE_REF`, then an explicit `options.baseRef`. The paperclip
fork's default branch is `master`, **not** `main` — so any deployment of this
hook against the fork MUST set `PAPERCLIP_PRECOMPLETION_BASE_REF=origin/master`
or every merge-kind issue will block on a ref that does not exist. This is
covered by T0-c.

### 1.3 The three 422 error codes

| Code | Fires when | Response fields |
| --- | --- | --- |
| `merge_kind_unmerged_branch` | branch resolved, workspace resolved, `merge-base --is-ancestor` exits 1 | `error`, `code`, `branch`, `evidence_command`, `hint` |
| `merge_kind_missing_branch` | title is merge-kind but `BRANCH_EXTRACTOR` finds nothing | `error`, `code` |
| `merge_kind_no_workspace` | branch resolved but `executionWorkspaceId` is null / unresolvable | `error`, `code`, `branch` |

`evidence_command` is the literal `git -C <cwd> merge-base --is-ancestor <branch> <baseRef>`
the operator can paste to reproduce. Its presence is asserted in T0-b because
a 422 without reproduction evidence is what made the NFM-3850 cluster so
expensive to triage.

### 1.4 The three metrics

| Metric | Labels | Source | State |
| --- | --- | --- | --- |
| `paperclip_precompletion_merge_rejected_total` | `reason` | `server/src/metrics/precompletion.ts` | implemented on NFM-3859, **not wired to the route** |
| `paperclip_precompletion_bypass_total` | `actor_kind` | same | implemented on NFM-3859, route uses a separate in-process counter |
| `paperclip_precompletion_backfill_run_total` | — | design doc only | **NOT IMPLEMENTED** anywhere (see §7 Gap 3) |

### 1.5 The feature flag

`precompletionMergeHookEnabled`, declared in
`packages/shared/src/types/instance.ts` and validated as
`z.boolean().default(false)` in `packages/shared/src/validators/instance.ts`.
Default **OFF**. The route re-reads it fresh on every `status=done` PATCH
(`instanceSettings.getExperimental()`) so an operator flip takes effect without
a restart — asserted in T5-d.

The backfill has its own independent flag, `phantomBackfillHookEnabled`
(NFM-3860). Turning the gate on does **not** turn the backfill on.

---

## 2. T0 — merge-kind issue with a non-ancestor branch is refused

**Discharges:** NFM-3855 AC-1 ("a merge-kind issue whose branch is not an
ancestor of the base ref cannot be marked done").

### Fixture

```ts
const issue = {
  id: "T0-issue",
  title: "Merge NFM-9999-feature to main",
  description: "",
  executionWorkspaceId: "ws-T0",
};
const workspace = { workspacePath: "/tmp/T0-repo", branchName: "NFM-9999-feature" };
```

Repo state: `NFM-9999-feature` exists with one commit that is **not** reachable
from `origin/main`.

### Cases

| Case | Setup | Assertion |
| --- | --- | --- |
| T0-a | flag on, actor `agent`, ancestor check exits 1 | `getMergeKindBlockReason` returns `code === "merge_kind_unmerged_branch"` |
| T0-b | as T0-a | payload carries `branch`, `evidence_command`, and `hint`; `evidence_command` re-runs cleanly in a shell and reproduces exit 1 |
| T0-c | as T0-a but `PAPERCLIP_PRECOMPLETION_BASE_REF=origin/master` | block still fires, and `evidence_command` names `origin/master` — proves fork deployments gate against the right ref |
| T0-d | route-level: `PATCH /api/issues/T0-issue {status:"done"}` | HTTP `422`; response body `code === "merge_kind_unmerged_branch"`; issue status in DB is **unchanged** |
| T0-e | as T0-d | a `logger.warn` line is emitted with `issueId`, `code`, `branch`, `actorType` |
| T0-f | title merge-kind, but `BRANCH_EXTRACTOR` finds nothing (`"Merge to main"`) | `code === "merge_kind_missing_branch"` |
| T0-g | branch extractable, `executionWorkspaceId: null` | `code === "merge_kind_no_workspace"`, payload carries `branch` |
| T0-h | post-NFM-3859 only | `paperclip_precompletion_merge_rejected_total{reason="non_ancestor_branch"}` increments by exactly 1 |

T0-d is the load-bearing case: the unit-level block payload is worthless if the
route still writes `done` to the database. Assert the DB row, not just the
HTTP status.

**Existing coverage:** `server/src/__tests__/precompletion-merge-hook.test.ts`
covers T0-a, T0-f, T0-g at unit level (`it("T0: returns merge_kind_unmerged_branch …")`).
T0-b through T0-e and T0-h are **new work**.

---

## 3. T1 — system actor bypasses the gate and is counted

**Discharges:** NFM-3855 AC-2 ("cron/system-driven merges are not blocked, and
every bypass is counted and audited").

### Fixture

T0's fixture, with `options.actorType = "system"`.

### Cases

| Case | Setup | Assertion |
| --- | --- | --- |
| T1-a | T0 fixture, actor `system`, flag on | returns `null` — the PATCH is allowed through |
| T1-b | as T1-a | in-process bypass counter (`getPrecompletionBypassCount()`) increments by 1 |
| T1-c | as T1-a, route level | an `issue.precompletion_bypass` activity row is written with `issueId`, `branch`, `actorId`, `bypassedAt` |
| T1-d | as T1-a, post-NFM-3859 | `paperclip_precompletion_bypass_total{actor_kind="system"}` increments by exactly 1 |
| T1-e | **non**-merge-kind issue, actor `system`, flag on | counter must **NOT** increment — see Gap 1 below; **this case currently FAILS** |
| T1-f | as T1-c | the audit row's `branch` field must name the bypassed branch — see Gap 2; **this case currently FAILS** |
| T1-g | actor `system`, flag **off** | no counter increment, no audit row (the route guards on `hookEnabled && system`) |

### Gap 1 — the bypass counter over-counts (defect, found while writing this plan)

`recordSystemBypass()` in `server/src/services/precompletion-merge-hook.ts:239`
is documented as incrementing "iff the actor is `system` **AND** the gate would
otherwise have fired". It does neither check — it increments unconditionally:

```ts
export function recordSystemBypass(input: {…}) {
  incrementPrecompletionBypass();          // ← unconditional
  return { action: "issue.precompletion_bypass", details: {…} };
}
```

The route calls it under `if (hookEnabled && actorTypeForGate === "system")`
only — with no merge-kind test. System actors drive every cron and board
wakeup, so in production this counter increments on **every** system-driven
`done` transition, the overwhelming majority of which are not merge-kind at
all. `paperclip_precompletion_bypass_total` therefore measures "system actors
closed an issue", not "the gate was bypassed", and T1-d would pass for entirely
the wrong reason.

**Required fix before flag-on:** gate the increment on `isMergeKind(issue)`
(and ideally on the block that *would* have been returned), then T1-e passes.

### Gap 2 — the audit row never records the branch

`server/src/routes/issues.ts` calls `recordSystemBypass({ …, branch: null })`
with a hardcoded `null`, even though `extractFeatureBranch(issue)` is available
at that point. Every audit row records `branch: null`, so the audit trail
cannot answer "which merge did we let through?" — precisely the question the
ghost-merge recovery path (§6) exists to answer.

**Required fix before flag-on:** pass `extractFeatureBranch(existing)`.

---

## 4. T2 — non-merge-kind issues are untouched

**Discharges:** NFM-3855 AC-3 ("the hook is invisible to ordinary issues").

This is the blast-radius test. The gate sits on the hot path of *every*
`status=done` PATCH in the product; a false positive here breaks all issue
completion, not just merges.

| Case | Title / description | Assertion |
| --- | --- | --- |
| T2-a | `"Implement dark mode toggle"` | returns `null`, no metric, no audit row |
| T2-b | `"Fix the merge conflict in issues.ts"` — contains "merge" but not as prefix | returns `null` (prefix anchor holds) |
| T2-c | `"Merge the review feedback"` — merge-prefixed, no `to main`, no `gh pr merge` | returns `null` |
| T2-d | `"Merge NFM-1 to develop"` — merge-prefixed, targets a non-base branch | returns `null` |
| T2-e | non-merge-kind, but description mentions `gh pr merge` and title does not start with `merge ` | returns `null` (both conditions required) |
| T2-f | route level, T2-a fixture | HTTP `200`, DB status becomes `done` |
| T2-g | post-NFM-3859, all of T2-a…f | **both** counters unchanged |

**Existing coverage:** T2-a, T2-b, T2-c, T2-e are covered at unit level today.
T2-d, T2-f, T2-g are new work.

---

## 5. T3 — merge-kind issue whose branch is already merged passes

**Discharges:** NFM-3855 AC-4 ("a truthful merge is never blocked").

### Fixture

T0's fixture, but `NFM-9999-feature` has been merged: `merge-base --is-ancestor`
exits 0.

| Case | Setup | Assertion |
| --- | --- | --- |
| T3-a | ancestor check exits 0 | returns `null` |
| T3-b | route level | HTTP `200`, DB status becomes `done` |
| T3-c | post-NFM-3859 | neither counter increments (a clean pass is not a bypass) |
| T3-d | branch tip **equals** the base ref tip (degenerate ancestor-of-self) | returns `null` — `--is-ancestor` treats a commit as its own ancestor |
| T3-e | branch merged via squash (tip not literally an ancestor, content merged) | returns `merge_kind_unmerged_branch` — **documented known limitation**, see §7 Gap 4 |

T3-e is deliberately listed as a *passing* test of a *failing* product
behaviour: the gate is ancestry-based, so a squash-merged branch reads as
unmerged. Teams that squash-merge must use the system-actor bypass or wait for
the ancestry-independent check. This must be stated in the flag-on runbook.

**Existing coverage:** T3-a covered at unit level. T3-b…e are new work.

---

## 6. T4 — backfill over the historical cluster produces no new phantoms

**Discharges:** NFM-3855 AC-5 ("the backfill identifies the known phantom
cluster and nothing else").

Backfill lives in `server/src/services/phantom-backfill.ts` (NFM-3860, ADR-010
§D2) with a nightly 05:00 UTC cron and its own `phantomBackfillHookEnabled`
flag. Detection SQL:

```sql
SELECT id FROM issues
WHERE status = 'done'
  AND created_at > '2026-08-01'
  AND (title ~* '^Merge\s+\S+\s+to\smain' OR title ~* '^Merge\s+\S+\s+branch')
  AND comment_count = 0
  AND assigned_agent_count_in_24h >= 3
```

| Case | Setup | Assertion |
| --- | --- | --- |
| T4-a | run against the NFM-3691 historical cluster | every issue in the known NFM-3850 cluster is flagged |
| T4-b | as T4-a | **zero** issues outside the NFM-3850 cluster are flagged — this is the headline AC |
| T4-c | as T4-a | NFM-3738 is **not** flagged (whitelisted: it is a truthful in-flight merge pending a real `git merge` of `origin/NFM-3691-board-api-key`) |
| T4-d | run T4-a twice | second run creates **zero** additional recovery children (idempotence via pre-fetched `<id>-phantom-recovery` identifiers) |
| T4-e | as T4-d, across a process restart | still zero — idempotence is DB-derived, not in-memory |
| T4-f | each flagged issue | a `[<identifier>-phantom-recovery]` child exists with `blockedByIssueIds` containing the phantom id, and is assigned to the most-recent assignee |
| T4-g | `PAPERCLIP_PHANTOM_BACKFILL_HOOK_ISSUE_ID` unset | child creation still succeeds; the second blocker is simply omitted (documented no-op) |
| T4-h | `phantomBackfillHookEnabled` false | run returns `skippedFlagOff` and mutates nothing |
| T4-i | design-doc metric | `paperclip_precompletion_backfill_run_total` increments once per run — **currently FAILS, metric does not exist (Gap 3)** |

T4-b is the case that decides whether the backfill can run unattended. A
detection rule that flags truthful merges generates recovery children for real
work and buries the operator; the false-positive rate matters more here than
the false-negative rate, because NFM-3850's phantoms are already enumerated.

**Existing coverage:** `server/src/__tests__/phantom-backfill.test.ts` and
`server/src/__tests__/adr010-phantom-backfill-schedule.test.ts` on the NFM-3860
branch cover T4-d, T4-f, T4-h. T4-a/b/c require the historical fixture and are
new work. T4-i cannot pass until Gap 3 is closed.

---

## 7. T5 — flag default-off makes the hook a no-op everywhere

**Discharges:** NFM-3855 AC-6 ("shipping the hook disabled changes nothing").

T5 is not a scenario, it is a *sweep*: re-run T0–T4 with
`precompletionMergeHookEnabled = false` and assert that every blocking outcome
becomes a pass-through.

| Case | Setup | Assertion |
| --- | --- | --- |
| T5-a | T0 fixture, flag off | returns `null`; route returns `200`; DB status becomes `done` |
| T5-b | T1 fixture, flag off | returns `null`; **no** bypass counter increment, **no** audit row |
| T5-c | T2, T3 fixtures, flag off | unchanged from flag-on behaviour (they were already pass-through) |
| T5-d | flip the flag on mid-run, no restart | the very next `status=done` PATCH blocks — the route re-reads `getExperimental()` per request |
| T5-e | flip the flag off mid-run | the next PATCH passes; no stale-cache block |
| T5-f | `validators/instance.ts` schema | `precompletionMergeHookEnabled` parses to `false` when the key is absent entirely |
| T5-g | post-NFM-3859, all of T5 | both Prometheus counters remain at zero for the whole sweep |
| T5-h | post-NFM-3858, ADK guard, flag off | guard is a no-op; `PATCH` reaches the API untouched |

**Existing coverage:** T5-a is covered (`it("hookEnabled=false → no-op even for
merge-kind issues")`), T5-f is covered in `instance.test.ts`. T5-b, T5-d, T5-e,
T5-g, T5-h are new work.

---

## 8. Cross-layer cases (NFM-3858 ADK runtime guard)

The runtime guard duplicates the heuristics inside `adapter-utils` so that a
supply-chain break in one layer does not disable the other. Duplication is a
deliberate design choice, which means **drift** is the risk under test.

| Case | Assertion |
| --- | --- |
| X-a | `isMergeKind` and `extractFeatureBranch` return identical results for the full T0–T3 title corpus across both copies |
| X-b | the guard's block codes are string-identical to the API's three codes |
| X-c | flag-fetch failure → guard **fails open** (allows) so the two layers never disagree in the blocking direction |
| X-d | guard blocks, API would also block → agent sees exactly one 422, not two |
| X-e | guard allows, API blocks → API is authoritative; the 422 still reaches the agent |

X-a should be implemented as a shared table-driven fixture asserted twice, not
two hand-maintained lists — a hand-maintained duplicate is the drift.

---

## 9. Known gaps (must be closed or explicitly accepted before flag-on)

| # | Gap | Impact | Blocking? |
| --- | --- | --- | --- |
| 1 | `recordSystemBypass` increments unconditionally (§3 Gap 1) | bypass metric measures the wrong thing; T1-e fails | **yes** |
| 2 | route passes `branch: null` to the audit row (§3 Gap 2) | audit trail cannot identify the bypassed merge; T1-f fails | **yes** |
| 3 | `paperclip_precompletion_backfill_run_total` unimplemented | backfill runs are unobservable; T4-i fails | no — backfill has its own flag |
| 4 | ancestry check misreads squash-merges (§5 T3-e) | truthful squash-merges block | no — document in runbook |
| 5 | metric `reason` labels (`non_ancestor_branch`, `no_extractable_branch`, `no_execution_workspace`) do **not** match the 422 `code` values (`merge_kind_*`), despite `metrics/precompletion.ts` asserting they MUST match | dashboards cannot join on the code an operator sees in the 422 | **yes** — pick one vocabulary |
| 6 | NFM-3859 counters are not called from `routes/issues.ts` | every "post-NFM-3859" assertion above is untestable until wiring lands | **yes** |
| 7 | fork default branch is `master`; hook defaults to `origin/main` (§1.2) | unset env → every merge-kind issue blocks on a nonexistent ref | **yes** for fork deploys |

Gaps 1, 2, 5, 6 and 7 are all wiring-level and all cheap. None require redesign.

---

## 10. Fail-open inventory

The hook fails open in three places. Each is intentional, and each needs a
negative test so that a fail-open path does not silently become the default
behaviour in production.

| Location | Trigger | Test |
| --- | --- | --- |
| `getMergeKindBlockReason` | `git` binary missing, or workspace cwd invalid (any exit code other than 1) | assert `null` returned **and** a warn-level log emitted — a silent fail-open is indistinguishable from a pass |
| ADK bridge guard | `GET /api/instance/settings/experimental` fails | assert `null`; API layer remains authoritative |
| Route | `resolveExecutionWorkspace` returns null | falls to `merge_kind_no_workspace` — this one fails *closed*; assert the asymmetry is deliberate |

The first row currently has **no** log emission — the function returns `null`
silently. Add one before flag-on, or an operator debugging "why did the gate not
fire" has nothing to read.

---

## 11. Ghost-merge recovery flow

When the gate blocks a merge that is in fact legitimate — the merge is in
flight, or was squash-merged (Gap 4) — the documented and **only** sanctioned
bypass is:

1. Confirm the merge really is in flight. NFM-3738 is the reference case: a
   truthful merge of `origin/NFM-3691-board-api-key` into `origin/main`, pending
   a real `git merge`. It is whitelisted in the backfill for exactly this reason.
2. Reproduce the block with the `evidence_command` from the 422 payload. If it
   exits 0, the gate is wrong and this is a bug — file it, do not bypass.
3. If it exits 1, complete the merge in git first. The gate is correct.
4. Only if the merge genuinely cannot be completed in git (squash-merge,
   history rewrite), route the transition through the **system actor**, which
   bypasses the gate and writes an `issue.precompletion_bypass` audit row.

Step 4 is auditable by design — that is the point of the bypass counter. It is
not a convenience path: every use is a row an operator can be asked about.
Note that until Gap 2 is fixed the row does not record which branch was
bypassed, which materially weakens this flow.

---

## 12. Acceptance-criteria traceability

| NFM-3855 AC | Scenario | Blocking gaps |
| --- | --- | --- |
| AC-1 non-ancestor branch cannot be marked done | T0 | — |
| AC-2 system actor bypasses, counted and audited | T1 | 1, 2 |
| AC-3 non-merge-kind issues unaffected | T2 | — |
| AC-4 truthful merge never blocked | T3 | 4 (accepted) |
| AC-5 backfill finds the cluster and nothing else | T4 | 3 (non-blocking) |
| AC-6 default-off is a no-op | T5 | — |
| cross-layer parity (NFM-3858) | X-a…X-e | 6 |

---

## 13. Execution

```bash
# API gate (present on master)
pnpm --filter @paperclipai/server test precompletion-merge-hook

# metrics (after NFM-3859 integration)
pnpm --filter @paperclipai/server test precompletion-metrics

# backfill (after NFM-3860 integration)
pnpm --filter @paperclipai/server test phantom-backfill
pnpm --filter @paperclipai/server test adr010-phantom-backfill-schedule

# ADK runtime guard (after NFM-3858 integration)
pnpm --filter @paperclipai/adapter-utils test precompletion-bridge-guard
```

Flag-on is gated on: all of T0–T5 green, Gaps 1/2/5/6/7 closed, and Gap 4
documented in the operator runbook.

---

## 14. References

- NFM-3850 — phantom-pass cluster (origin)
- NFM-3853 — RCA + prevention hook design doc
- NFM-3855 — implementation issue, acceptance criteria (cancelled; ACs still authoritative)
- NFM-3857 — API-layer gate
- NFM-3858 — ADK runtime bridge guard
- NFM-3859 — Prometheus counters, `docs/precompletion-metrics-dashboard.md`
- NFM-3860 — backfill service + nightly cron
- NFM-3166 — agent-level precedent gate
- NFM-3738 — the truthful in-flight merge; must never be flagged
- NFM-3862 / NFM-3877 — original authoring, and this recovery

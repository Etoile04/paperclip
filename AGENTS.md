# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

## 2. Read This First

Before making changes, read in this order:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

`doc/SPEC.md` is long-horizon product context.
`doc/SPEC-implementation.md` is the concrete V1 build contract.

## 3. Repo Map

- `server/`: Express REST API and orchestration services
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `packages/adapters/`: agent adapter implementations (Claude, Codex, Cursor, etc.)
- `packages/adapter-utils/`: shared adapter utilities
- `packages/plugins/`: plugin system packages
- `doc/`: operational and product docs

## 4. Dev Setup (Auto DB)

Use embedded PGlite in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB:

```sh
rm -rf data/pglite
pnpm dev
```

## 5. Core Engineering Rules

1. Keep changes company-scoped.
Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services.

2. Keep contracts synchronized.
If you change schema/API behavior, update all impacted layers:
- `packages/db` schema and exports
- `packages/shared` types/constants/validators
- `server` routes/services
- `ui` API clients and pages

3. Preserve control-plane invariants.
- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions

4. Do not replace strategic docs wholesale unless asked.
Prefer additive updates. Keep `doc/SPEC.md` and `doc/SPEC-implementation.md` aligned.

5. Keep repo plan docs dated and centralized.
When you are creating a plan file in the repository itself, new plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames. This does not replace Paperclip issue planning: if a Paperclip issue asks for a plan, update the issue `plan` document per the `paperclip` skill instead of creating a repo markdown file.

6. Attach inspectable generated artifacts.
When your task produces a user-inspectable deliverable file, follow the Paperclip skill's "Generated Artifacts and Work Products" workflow before final disposition. In this repo, prefer the self-contained skill helper at `skills/paperclip/scripts/paperclip-upload-artifact.sh` so the file is available through the Paperclip API, create/update an artifact work product when the file is the deliverable, link the uploaded artifact in the final issue comment, and then set status. Do not rely on local filesystem paths as the only access path. If an important file intentionally remains workspace-only, create/update a work product with `metadata.resourceRef.kind: "workspace_file"` and a workspace-relative path, then name that work product and path in the final comment. Treat browse/search as a fallback for recovering workspace files, not the preferred deliverable path. See `doc/AGENT-ARTIFACTS.md` for details and `.mp4`/`.webm` examples.

## 6. Database Change Workflow

When changing data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm -r typecheck
```

Notes:
- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. Verification Before Hand-off

Default local/agent test path:

```sh
pnpm test
```

This is the cheap default and only runs the Vitest suite. Browser suites stay opt-in:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

Run the browser suites only when your change touches them or when you are explicitly verifying CI/release flows.

For normal issue work, run the smallest relevant verification first. Do not default to repo-wide typecheck/build/test on every heartbeat when a narrower check is enough to prove the change.

Run this full check before claiming repo work done in a PR-ready hand-off, or when the change scope is broad enough that targeted checks are not sufficient:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

## 8. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 9. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

## 10. Pull Request Requirements

When creating a pull request (via `gh pr create` or any other method), you **must** read and fill in every section of [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). Do not craft ad-hoc PR bodies — use the template as the structure for your PR description. Required sections:

- **Thinking Path** — trace reasoning from project context to this change (see `CONTRIBUTING.md` for examples)
- **What Changed** — bullet list of concrete changes
- **Verification** — how a reviewer can confirm it works
- **Risks** — what could go wrong
- **Model Used** — the AI model that produced or assisted with the change (provider, exact model ID, context window, capabilities). Write "None — human-authored" if no AI was used.
- **Checklist** — all items checked

## 11. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)
6. If the issue is **merge-kind**, the merge is evidenced in git before `done` — see §12 PreCompletionMerge Hook

## 11. Fork-Specific: HenkDz/paperclip

This is a fork of `paperclipai/paperclip` with QoL patches and a **built-in** Hermes adapter story on branch `feat/externalize-hermes-adapter` ([tree](https://github.com/HenkDz/paperclip/tree/feat/externalize-hermes-adapter)).

### Branch Strategy

- `feat/externalize-hermes-adapter` now ships `hermes_local` and `hermes_gateway` as built-in core adapters.
- Older fork branches may still document plugin-only Hermes; treat this file as authoritative for the current branch.

### Hermes (built-in)

- `hermes_local` is available without Adapter manager installation and runs the local Hermes CLI.
- `hermes_gateway` is available without Adapter manager installation and calls an already-running Hermes API server.
- Operators may still install external Hermes packages through Adapter manager to override/shadow the built-ins.
- Optional: `file:` entry in `~/.paperclip/adapter-plugins.json` remains useful for local development of override packages.

### Local Dev

- Fork runs on port 3101+ (auto-detects if 3100 is taken by upstream instance)
- `npx vite build` hangs on NTFS — use `node node_modules/vite/bin/vite.js build` instead
- Server startup from NTFS takes 30-60s — don't assume failure immediately
- Kill ALL paperclip processes before starting: `pkill -f "paperclip"; pkill -f "tsx.*index.ts"`
- Vite cache survives `rm -rf dist` — delete both: `rm -rf ui/dist ui/node_modules/.vite`

### Fork QoL Patches (not in upstream)

These are local modifications in the fork's UI. If re-copying source, these must be re-applied:

1. **stderr_group** — amber accordion for MCP init noise in `RunTranscriptView.tsx`
2. **tool_group** — accordion for consecutive non-terminal tools (write, read, search, browser)
3. **Dashboard excerpt** — `LatestRunCard` strips markdown, shows first 3 lines/280 chars

### Plugin System

PR #2218 (`feat/external-adapter-phase1`) adds external adapter support. See root `AGENTS.md` for full details.

- Adapters can be loaded as external plugins via `~/.paperclip/adapter-plugins.json`
- The plugin-loader should have ZERO hardcoded adapter imports — pure dynamic loading
- `createServerAdapter()` must include ALL optional fields (especially `detectModel`)
- Built-in UI adapters can shadow external plugin parsers; external override pause/resume should restore the built-in parser.
- Reference external adapters: Droid (npm); Hermes can also be tested as an override package.

## 12. PreCompletionMerge Hook — what CTO agents must NOT trip on

> Numbering note: the issue that commissioned this section (NFM-3862 / NFM-3877)
> specified "§9, after §8". That assumed a different file layout — this file's
> §9 is already **UI Expectations**, and §8 is **API and Auth Expectations**.
> Inserting there would renumber three sections and break existing references,
> so the section is appended as §12 and cross-linked from §11 Definition of Done.

**Read this before marking any merge-kind issue `done`.**

The PreCompletionMerge hook (ADR-009 §4.4, NFM-3853/3855/3857) is an API-layer
gate in front of `PATCH /api/issues/{id}`. It refuses the `status=done`
transition with a `422` when an issue *claims* to be a merge but the named
branch is not yet an ancestor of the base ref. It exists because of the
NFM-3850 **phantom pass** cluster: issues marked `done` for merges that never
landed in git. Paperclip said merged; git said nothing; the work was stranded.

### When the gate fires

An issue is **merge-kind** when its title starts with `merge ` (case-insensitive)
**and** either the title targets `to main` / `to origin/main`, **or** the
description mentions `gh pr merge`. For a merge-kind issue the PreCompletionMerge
gate runs `git merge-base --is-ancestor <branch> <baseRef>` in the issue's
execution workspace. Exit 0 allows the transition; exit 1 blocks it.

Ordinary issues are never touched — the gate returns immediately for anything
that is not merge-kind.

### The three 422 codes

| `code` | Meaning | What to do |
| --- | --- | --- |
| `merge_kind_unmerged_branch` | the branch is not an ancestor of the base ref | actually merge it, then retry `done` |
| `merge_kind_missing_branch` | title is merge-kind but names no extractable branch | fix the title to `Merge <branch> to main` |
| `merge_kind_no_workspace` | merge-kind issue has no execution workspace | attach a workspace, or the gate cannot verify anything |

A `merge_kind_unmerged_branch` response carries `branch`, `hint`, and an
`evidence_command` — the literal git invocation that produced the rejection.
Run it. If it exits 0 the gate is wrong and you have found a bug; file it
rather than working around it.

### Feature flag

`precompletionMergeHookEnabled`, an instance experimental setting,
`z.boolean().default(false)` — **default OFF**. When off, the PreCompletionMerge
hook is a complete no-op. The route re-reads the flag on every `status=done`
PATCH, so an operator flip takes effect without a restart.

The backfill (ADR-010 §D2, NFM-3860) has a separate flag,
`phantomBackfillHookEnabled`. Enabling the gate does not enable the backfill.

**Fork deployments:** the hook defaults its base ref to `origin/main`, but this
fork's default branch is `master`. Set
`PAPERCLIP_PRECOMPLETION_BASE_REF=origin/master` before enabling the flag here,
or every merge-kind issue will block against a ref that does not exist.

### Metrics

- `paperclip_precompletion_merge_rejected_total{reason}` — 422s emitted by the gate.
- `paperclip_precompletion_bypass_total{actor_kind}` — transitions let through
  despite being merge-kind, because the actor was trusted.

Be aware the `reason` label values (`non_ancestor_branch`,
`no_extractable_branch`, `no_execution_workspace`) do **not** currently match
the 422 `code` values above; dashboards cannot join the two vocabularies until
that is reconciled.

### System-actor bypass

Actors of type `system` (cron and board-driven wakeups) bypass the gate
entirely and increment `paperclip_precompletion_bypass_total`, writing an
`issue.precompletion_bypass` activity row. This is deliberate — it lets
legitimate in-flight merges land — but it is **audited, not free**. Every
bypass is a row an operator can ask you about.

### Ghost-merge recovery

If the gate blocks a merge you believe is legitimate (typically: the merge is
genuinely in flight, or the branch was squash-merged so its tip is not literally
an ancestor), the only sanctioned path is:

1. Reproduce with the `evidence_command` from the 422 body.
2. If it exits 1, the gate is right — finish the merge in git first.
3. If the merge truly cannot be completed in git, route the transition through
   the system actor so the bypass is recorded.

NFM-3738 is the reference case for a truthful in-flight merge and is
whitelisted in the backfill; it must never be flagged as a phantom.

### For CTO orchestrators specifically

Do not mark a merge-kind issue `done` on the strength of an agent's handoff
comment. The comment is a claim; `git merge-base --is-ancestor` is the evidence.
If the PreCompletionMerge gate is disabled in your instance, run the check
yourself before closing the issue — that is exactly the step whose absence
produced NFM-3850.

Full scenario coverage: [`docs/precompletion-merge-hook-test-plan.md`](docs/precompletion-merge-hook-test-plan.md).

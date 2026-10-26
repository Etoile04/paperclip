# Auth-Episode Recovery (NFM-5748)

What operators see during and after a `claude_auth_required` episode, and
what the control plane does automatically.

## During an episode (provider red)

Every agent whose run dies with `claude_auth_required` (shared upstream
Claude credential rejected) latches:

- the run lands `failed` with error code `claude_auth_required`;
- the agent's status flips to `error` with a human-readable `errorReason`
  on the agent page and attention surface;
- the agent's heartbeat timers stop ticking an `error` agent, so nothing
  self-heals — this is the latch.

Failures during this phase only **record the episode** (one row per company
in `auth_recovery_episodes`, state `red`). No wakeups are sent while the
provider is red.

## The green trigger

The first successful authenticated `claude_local` run after the first
failure closes the red phase (the `[SRE-RECOVERED]` canary signal from the
sibling canary lane is an equivalent trigger, whichever comes first). The
episode flips to `recovering` and the control plane re-enqueues wakeups:

- **Eligible**: agents with a latched `claude_auth_required` run since the
  episode started, still in `error`, with no successful run since the
  episode started. Duplicate latch runs collapse to one wake per agent.
- **Bounds**: ≤3 wake attempts per agent, 10 minutes apart, stopping on the
  agent's first successful run; at most 20 wakes per episode (thundering-
  herd guard on a recovering relay). The order is deterministic (first
  latch time, then agent id).
- **Pause/resume**: if the provider re-breaks mid-recovery (another
  `claude_auth_required` failure), the episode drops back to `red` and due
  retries hold until the next green observation resumes them. Attempt
  counts and spacing are preserved across pauses.
- **Closure**: once every enrolled agent is recovered, exhausted, or manual,
  the episode closes. A later failure starts a fresh episode with a fresh
  20-wake budget.

## What operators see (R4)

On recovery, each still-latched agent's `errorReason` is annotated, e.g.:

```
auth recovered at 2026-10-26T09:40:00.000Z — 12 agents re-enqueued / 4 manual (wake cap 20/episode); this agent: wake 1/3 enqueued, next retry after 2026-10-26T09:50:00.000Z
```

Dispositions:

| Suffix | Meaning | Operator action |
| --- | --- | --- |
| `wake k/3 enqueued, next retry after <T>` | The control plane woke the agent; retries are scheduled | None — watch for the agent leaving `error` |
| `manual — wake cap reached, needs a manual wake` | The 20-wake episode budget was spent before this agent's turn | Send one manual wake (assignment, comment, or board wakeup) |
| `3/3 wakes did not produce a successful run — manual wake required` | Bounded retries gave up on this agent | Investigate the agent's adapter/session, then wake manually |

A successful run clears the agent's `errorReason` through the normal
agent-status path, so recovered agents need no manual cleanup.

## State reference

Tables (migration `0310_auth_recovery_episodes`):

- `auth_recovery_episodes` — one episode per company while active
  (`red` → `recovering` → `closed`), with the fleet counters
  (`reenqueued_count`, `manual_count`, `wakes_used`) the annotations show.
- `auth_recovery_episode_agents` — per-agent enrollment with the
  compare-and-swap `attempts` counter (two concurrent greens can never
  double-wake one agent).

Module: `server/src/modules/auth-recovery/` (policy, use-cases, postgres
adapter). Hooks: run settlement in `server/src/services/heartbeat.ts`
(failure → `observeAuthFailure`, green `claude_local` run →
`observeGreen`) and the periodic heartbeat recovery chain in
`server/src/index.ts` (`sweepAuthRecoveryReenqueues`, also run once at
startup after a restart).

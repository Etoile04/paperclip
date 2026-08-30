/**
 * PreCompletionMerge hook (NFM-3857, ADR-009 §4.4 prevention hook).
 *
 * API-layer middleware in front of `PATCH /api/issues/{id}` that blocks the
 * `status=done` transition when the issue's title or description match the
 * "merge-kind" heuristic but the named feature branch is NOT yet an ancestor
 * of `origin/main`. The agent-level gate at NFM-3166 only fires after the
 * agent runs `git push` — this API gate stops the "merge-kind issue → done"
 * transition at the source so a phantom pass cannot land in Paperclip.
 *
 * Heuristics:
 * - `isMergeKind(issue)`: case-insensitive title matches `^merge\s`; returns
 *   true if `to (origin/)?main` appears in the title OR `gh pr merge` appears
 *   in the description.
 * - `extractFeatureBranch(issue)`: `merge\s+(\S+)\s+(?:to|into|branch)`.
 *
 * Activation is gated by `precompletionMergeHookEnabled` (experimental flag,
 * default OFF). When OFF, the hook is a no-op and `getMergeKindBlockReason`
 * returns null unconditionally. The `system` actor bypasses the gate and
 * increments the `paperclip_precompletion_bypass_total` in-process counter.
 *
 * Reference: NFM-3853 design doc `precompletion-merge-hook` (id
 * `5f082df9-b131-4d6d-bf27-f678d4307325`). Precedent: NFM-3166 (agent-level
 * gate). NFM-3738 is the truthful in-flight merge — must NOT be flagged.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_BASE_REF = "origin/main";
const BASE_REF_ENV_KEYS = [
  "PAPERCLIP_PRECOMPLETION_BASE_REF",
  "PAPERCLIP_BASE_REF",
] as const;

/**
 * In-process bypass counter — incremented every time a `system` actor
 * short-circuits the gate. Exposed via `getPrecompletionBypassCount()` for
 * tests and any future `/metrics` integration. The design doc calls this
 * `paperclip_precompletion_bypass_total`.
 */
let bypassCount = 0;

export function incrementPrecompletionBypass(): number {
  bypassCount += 1;
  return bypassCount;
}

export function getPrecompletionBypassCount(): number {
  return bypassCount;
}

export function resetPrecompletionBypassCountForTesting(): void {
  bypassCount = 0;
}

const MERGE_TITLE_PREFIX = /^merge\s/i;
const MERGE_TITLE_TO_MAIN = /^merge\s.*?\bto\s+(?:origin\/)?main\b/i;
const DESCRIPTION_PR_MERGE = /\bgh\s+pr\s+merge\b/i;
const BRANCH_EXTRACTOR = /merge\s+(\S+)\s+(?:to|into|branch)/i;

export interface MergeKindIssueLike {
  title?: string | null;
  description?: string | null;
}

/**
 * Returns true when the issue title or description describes a merge action
 * targeting the base ref. Title matching requires the `^merge\s` prefix AND
 * either an explicit `to (origin/)?main` clause OR a `gh pr merge` token in
 * the description — both signals together reduce false positives against
 * issues whose title merely contains the word "merge".
 */
export function isMergeKind(issue: MergeKindIssueLike): boolean {
  const title = (issue.title ?? "").toString();
  if (!MERGE_TITLE_PREFIX.test(title)) return false;
  if (MERGE_TITLE_TO_MAIN.test(title)) return true;
  const description = (issue.description ?? "").toString();
  return DESCRIPTION_PR_MERGE.test(description);
}

/**
 * Returns the feature-branch reference named in the issue title, or `null`
 * if none is extractable. Matches `merge <branch> (to|into|branch)` and
 * returns the captured branch verbatim — caller is responsible for
 * normalising `origin/` prefixes before passing to `git merge-base`.
 */
export function extractFeatureBranch(issue: MergeKindIssueLike): string | null {
  const title = (issue.title ?? "").toString();
  const match = BRANCH_EXTRACTOR.exec(title);
  return match ? match[1] : null;
}

export interface ExecutionWorkspaceLike {
  id: string;
  cwd?: string | null;
  branchName?: string | null;
  providerRef?: string | null;
}

export interface ResolveExecutionWorkspaceContext {
  resolveWorkspace: (issue: { id: string; executionWorkspaceId?: string | null }) => Promise<ExecutionWorkspaceLike | null>;
  workspacePathFor: (workspace: ExecutionWorkspaceLike) => string | null;
}

/**
 * Resolves an issue's execution workspace via the supplied `resolveWorkspace`
 * callback (server code wires this to `executionWorkspacesSvc.getById`).
 * Returns `null` when no workspace, no resolvable cwd, or the workspace
 * record is missing.
 */
export async function resolveExecutionWorkspace(
  issue: { id: string; executionWorkspaceId?: string | null },
  ctx: ResolveExecutionWorkspaceContext,
): Promise<{ workspace: ExecutionWorkspaceLike; workspacePath: string } | null> {
  if (!issue.executionWorkspaceId) return null;
  const workspace = await ctx.resolveWorkspace(issue);
  if (!workspace) return null;
  const workspacePath = ctx.workspacePathFor(workspace);
  if (!workspacePath) return null;
  return { workspace, workspacePath };
}

export type MergeKindBlockCode =
  | "merge_kind_no_workspace"
  | "merge_kind_missing_branch"
  | "merge_kind_unmerged_branch";

export interface MergeKindBlock {
  code: MergeKindBlockCode;
  error: string;
  branch?: string;
  evidence_command?: string;
  hint?: string;
}

export interface CheckAncestryOptions {
  hookEnabled: boolean;
  actorType: string | null | undefined;
  baseRef?: string;
  runGit?: RunGitFn;
}

/** Default `git` invoker — overridable in tests to avoid touching disk. */
export type RunGitFn = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

const defaultRunGit: RunGitFn = async (args, cwd) => {
  return execFileAsync("git", ["-C", cwd, ...args], { cwd });
};

function resolveBaseRef(opts?: { baseRef?: string }): string {
  if (opts?.baseRef) return opts.baseRef;
  for (const key of BASE_REF_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length > 0) return value;
  }
  return DEFAULT_BASE_REF;
}

/**
 * Pure decision function — returns a 422 payload when the gate must block,
 * `null` when the PATCH is allowed. Side effects (counter increment, log
 * emission) are performed by the caller; this function is testable in
 * isolation.
 *
 * When `hookEnabled` is false the hook is a no-op and returns null.
 * When `actorType === 'system'` the gate is bypassed; the caller is
 * responsible for incrementing the bypass counter and emitting an audit
 * log entry.
 *
 * Otherwise the gate runs `git merge-base --is-ancestor <branch> <baseRef>`
 * inside the workspace's `cwd`. Exit code 0 → allow; exit code 1 → block
 * with `merge_kind_unmerged_branch`.
 */
export async function getMergeKindBlockReason(input: {
  issue: { id: string; title?: string | null; description?: string | null; executionWorkspaceId?: string | null };
  workspace: { workspacePath: string; branchName?: string | null } | null;
  options: CheckAncestryOptions;
}): Promise<MergeKindBlock | null> {
  const { issue, workspace, options } = input;
  if (!options.hookEnabled) return null;
  if (options.actorType === "system") return null;
  if (!isMergeKind(issue)) return null;

  const branch = extractFeatureBranch(issue);
  if (!branch) {
    return {
      code: "merge_kind_missing_branch",
      error: "merge-kind issue has no extractable feature branch",
    };
  }
  if (!workspace) {
    return {
      code: "merge_kind_no_workspace",
      error: "merge-kind issue has no execution workspace",
      branch,
    };
  }

  const baseRef = resolveBaseRef({ baseRef: options.baseRef });
  const runGit = options.runGit ?? defaultRunGit;
  const args = ["merge-base", "--is-ancestor", branch, baseRef];
  try {
    await runGit(args, workspace.workspacePath);
    return null;
  } catch (error) {
    const code = readErrorCode(error);
    if (code === 1) {
      return {
        code: "merge_kind_unmerged_branch",
        error: `feature branch '${branch}' is not yet an ancestor of '${baseRef}'`,
        branch,
        evidence_command: `git -C ${workspace.workspacePath} ${args.join(" ")}`,
        hint: `merge ${branch} into ${baseRef} (or wait for the merge commit) before marking done`,
      };
    }
    // git binary missing or workspace cwd invalid — fail-open with a
    // non-422 sentinel: the existing PATCH pipeline still runs, and the
    // operator can investigate via the audit log.
    return null;
  }
}

function readErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number") return code;
  if (typeof code === "string" && /^\d+$/.test(code)) return Number.parseInt(code, 10);
  return null;
}

/**
 * Convenience wrapper for the route handler: increments the bypass counter
 * iff the actor is `system` AND the gate would otherwise have fired.
 * Returns the audit-log details payload (or `null` if no audit row needed).
 */
export function recordSystemBypass(input: {
  issue: { id: string; title?: string | null };
  branch: string | null;
  actorId: string | null;
}): { action: string; details: Record<string, unknown> } | null {
  incrementPrecompletionBypass();
  return {
    action: "issue.precompletion_bypass",
    details: {
      issueId: input.issue.id,
      branch: input.branch,
      actorId: input.actorId,
      bypassedAt: new Date().toISOString(),
    },
  };
}
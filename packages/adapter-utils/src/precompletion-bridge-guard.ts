/**
 * Defense-in-depth: ADK runtime middleware hook (NFM-3858, ADR-009 §4.4).
 *
 * Mirrors the API-layer PreCompletionMerge gate at the adapter-runtime
 * boundary.  When an in-sandbox agent issues `PATCH /api/issues/{id}`
 * with `{ status: "done" }`, this guard intercepts the request BEFORE it
 * reaches the Paperclip API server and runs the same merge-kind heuristic
 * and `git merge-base --is-ancestor` check.
 *
 * The two layers are intentionally independent:
 * - API layer (NFM-3857): `server/src/services/precompletion-merge-hook.ts`
 * - Runtime layer (NFM-3858): this file
 *
 * Pure heuristic functions (`isMergeKind`, `extractFeatureBranch`) are
 * duplicated rather than shared because `adapter-utils` has zero
 * intra-monorepo dependencies — keeping the two copies independent
 * means a supply-chain break in one layer does not disable the other.
 *
 * Feature-flag gating mirrors the API: the guard fetches
 * `GET /api/instance/settings/experimental` once (cached for the run)
 * and short-circuits to a no-op when the flag is absent or `false`.
 * If the flag-fetch itself fails the guard fails OPEN (allows the
 * request through) so the two layers never disagree in the blocking
 * direction — the API layer is always the authoritative gate.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Pure heuristic functions (duplicated from server PreCompletionMerge hook)
// ---------------------------------------------------------------------------

const MERGE_TITLE_PREFIX = /^merge\s/i;
const MERGE_TITLE_TO_MAIN = /^merge\s.*?\bto\s+(?:origin\/)?main\b/i;
const DESCRIPTION_PR_MERGE = /\bgh\s+pr\s+merge\b/i;
const BRANCH_EXTRACTOR = /merge\s+(\S+)\s+(?:to|into|branch)/i;

/**
 * Returns true when the issue title or description describe a merge action
 * targeting the base ref.  Mirrors `isMergeKind` in the server hook.
 */
export function isMergeKind(title: string, description: string): boolean {
  if (!MERGE_TITLE_PREFIX.test(title)) return false;
  if (MERGE_TITLE_TO_MAIN.test(title)) return true;
  return DESCRIPTION_PR_MERGE.test(description);
}

/**
 * Returns the feature-branch reference named in the issue title, or null.
 * Mirrors `extractFeatureBranch` in the server hook.
 */
export function extractFeatureBranch(title: string): string | null {
  const match = BRANCH_EXTRACTOR.exec(title);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Git merge-base check
// ---------------------------------------------------------------------------

export type RunGitFn = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

const defaultRunGit: RunGitFn = async (args, cwd) => {
  return execFileAsync("git", ["-C", cwd, ...args], { cwd });
};

function resolveBaseRef(baseRef?: string): string {
  if (baseRef && baseRef.length > 0) return baseRef;
  return process.env.PAPERCLIP_PRECOMPLETION_BASE_REF
    ?? process.env.PAPERCLIP_BASE_REF
    ?? "origin/main";
}

/**
 * Runs `git merge-base --is-ancestor <branch> <baseRef>` in the workspace.
 * Returns `true` when the branch is an ancestor (merged), `false` otherwise.
 * Returns `true` (fail-open) on any unexpected git error (binary missing,
 * invalid cwd, etc.) so the API layer remains the authoritative gate.
 */
export async function checkBranchAncestry(input: {
  branch: string;
  workspacePath: string;
  baseRef?: string;
  runGit?: RunGitFn;
}): Promise<boolean> {
  const baseRef = resolveBaseRef(input.baseRef);
  const runGit = input.runGit ?? defaultRunGit;
  try {
    await runGit(["merge-base", "--is-ancestor", input.branch, baseRef], input.workspacePath);
    return true;
  } catch (error: unknown) {
    const code = readExitCode(error);
    if (code === 1) return false;
    // Any other error (git missing, invalid cwd, etc.) — fail open.
    return true;
  }
}

function readExitCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const c = (error as Record<string, unknown>).code;
  if (typeof c === "number") return c;
  if (typeof c === "string" && /^\d+$/.test(c)) return Number.parseInt(c, 10);
  return null;
}

// ---------------------------------------------------------------------------
// Bridge guard
// ---------------------------------------------------------------------------

const ISSUES_PATCH_PATTERN = /^\/api\/issues\/([a-f0-9-]+)$/;
const DONE_BODY_PATTERN = /"status"\s*:\s*"done"/;

export interface BridgeGuardResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface PrecompletionBridgeGuardInput {
  apiUrl: string;
  apiToken: string;
  workspacePath: string;
  runId?: string;
  runGit?: RunGitFn;
  fetchFn?: typeof fetch;
}

export interface PrecompletionBridgeGuard {
  /**
   * Intercept a bridge request.  Returns a 422 response if the
   * precompletion check fails, or `null` to allow the request through
   * to the API server.
   */
  intercept(request: { method: string; path: string; body?: string }): Promise<BridgeGuardResponse | null>;
}

/**
 * Creates a precompletion bridge guard instance.
 *
 * The guard lazily fetches the `precompletionMergeHookEnabled` experimental
 * flag on the first `intercept` call that looks like a done-transition PATCH.
 * If the fetch fails, the guard assumes the flag is OFF and allows all
 * requests through (fail-open).
 */
export function createPrecompletionBridgeGuard(
  input: PrecompletionBridgeGuardInput,
): PrecompletionBridgeGuard {
  const { apiUrl, apiToken, workspacePath, runId } = input;
  const runGit = input.runGit ?? defaultRunGit;
  const fetchFn = input.fetchFn ?? fetch;

  // Lazy-cached flag: undefined = not yet fetched, null = fetch failed,
  // boolean = known value.
  let cachedFlag: boolean | null | undefined = undefined;

  function buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    };
    if (runId) h["x-paperclip-run-id"] = runId;
    if (extra) Object.assign(h, extra);
    return h;
  }

  async function fetchExperimentalFlag(): Promise<boolean> {
    if (cachedFlag !== undefined) return cachedFlag === true;
    try {
      const url = `${apiUrl.replace(/\/$/, "")}/api/instance/settings/experimental`;
      const resp = await fetchFn(url, {
        headers: buildHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as Record<string, unknown>;
        const enabled = data.precompletionMergeHookEnabled === true;
        cachedFlag = enabled;
        return enabled;
      }
      // Non-OK response — fail open.
      cachedFlag = null;
      return false;
    } catch {
      // Network error / timeout — fail open.
      cachedFlag = null;
      return false;
    }
  }

  async function fetchIssueTitle(
    issueId: string,
  ): Promise<{ title: string; description: string } | null> {
    try {
      const url = `${apiUrl.replace(/\/$/, "")}/api/issues/${issueId}`;
      const resp = await fetchFn(url, {
        headers: buildHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as Record<string, unknown>;
      return {
        title: String(data.title ?? ""),
        description: String(data.description ?? ""),
      };
    } catch {
      return null;
    }
  }

  return {
    async intercept(request): Promise<BridgeGuardResponse | null> {
      // Quick-reject: only PATCH /api/issues/{id} with status: "done"
      const method = request.method.trim().toUpperCase();
      if (method !== "PATCH") return null;
      const pathMatch = ISSUES_PATCH_PATTERN.exec(request.path);
      if (!pathMatch) return null;
      if (!DONE_BODY_PATTERN.test(request.body ?? "")) return null;

      // Check feature flag (lazily fetched, cached for run lifetime).
      const hookEnabled = await fetchExperimentalFlag();
      if (!hookEnabled) return null;

      // Fetch issue title/description for merge-kind heuristic.
      const issueId = pathMatch[1];
      const issue = await fetchIssueTitle(issueId);
      if (!issue) return null; // fail open on fetch failure

      if (!isMergeKind(issue.title, issue.description)) return null;

      const branch = extractFeatureBranch(issue.title);
      if (!branch) {
        return make422({
          code: "merge_kind_missing_branch",
          error: "merge-kind issue has no extractable feature branch",
        });
      }

      const isAncestor = await checkBranchAncestry({
        branch,
        workspacePath,
        runGit,
      });
      if (!isAncestor) {
        return make422({
          code: "merge_kind_unmerged_branch",
          error: `feature branch '${branch}' is not yet an ancestor of '${resolveBaseRef()}'`,
          branch,
        });
      }

      return null; // all checks passed — allow through to API server
    },
  };
}

// ---------------------------------------------------------------------------
// Response builder
// ---------------------------------------------------------------------------

function make422(input: {
  code: string;
  error: string;
  branch?: string;
}): BridgeGuardResponse {
  const body: Record<string, unknown> = {
    error: input.error,
    code: input.code,
  };
  if (input.branch) body.branch = input.branch;
  return {
    status: 422,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}


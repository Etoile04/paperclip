/**
 * PreCompletionMerge hook (NFM-3857) — T0-T3 unit tests.
 *
 * Covers the four design-doc scenarios:
 *  - T0: synthetic merge-kind issue with non-ancestor branch → 422
 *    `merge_kind_unmerged_branch`.
 *  - T1: same as T0 but actor is `system` → pass-through + bypass counter
 *    increments.
 *  - T2: non-merge-kind issue marked `done` → pass-through, NO metric.
 *  - T3: merge-kind issue with branch already an ancestor of main →
 *    pass-through.
 *
 * Plus the AC flags:
 *  - flag-off → no-op even for merge-kind issues
 *  - `merge_kind_no_workspace` when executionWorkspaceId is missing
 *  - `merge_kind_missing_branch` when title has no extractable branch
 *  - non-`done` status transitions are passed through unchanged
 *    (exercised via the route-level handler in the integration test, not
 *    here — the decision function is status-agnostic)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractFeatureBranch,
  getMergeKindBlockReason,
  getPrecompletionBypassCount,
  incrementPrecompletionBypass,
  isMergeKind,
  recordSystemBypass,
  resetPrecompletionBypassCountForTesting,
  type RunGitFn,
} from "../services/precompletion-merge-hook.js";

const syntheticRunGit = (
  outcomes: Record<string, { rc: number; error?: Error }>,
): RunGitFn => {
  return async (args, cwd) => {
    const key = args.join(" ");
    const outcome = outcomes[key];
    if (!outcome) {
      throw new Error(`syntheticRunGit: unexpected call key='${key}' cwd='${cwd}'`);
    }
    if (outcome.rc === 0) return { stdout: "", stderr: "" };
    const err = outcome.error ?? new Error("git exited non-zero");
    (err as Error & { code?: number }).code = outcome.rc;
    throw err;
  };
};

describe("isMergeKind", () => {
  it("returns true for 'merge <branch> to main' titles", () => {
    expect(isMergeKind({ title: "Merge feature-x to main" })).toBe(true);
    expect(isMergeKind({ title: "merge feature-x to origin/main" })).toBe(true);
    expect(isMergeKind({ title: "MERGE feature-x TO MAIN" })).toBe(true);
  });

  it("returns true when title lacks 'to main' but description mentions `gh pr merge`", () => {
    expect(
      isMergeKind({
        title: "Merge feature-x",
        description: "Will run `gh pr merge --auto` once CI green.",
      }),
    ).toBe(true);
  });

  it("returns false for non-merge titles", () => {
    expect(isMergeKind({ title: "Refactor ingestion worker" })).toBe(false);
    expect(isMergeKind({ title: "Fix merge conflict in pricing" })).toBe(false);
    expect(isMergeKind({ title: "" })).toBe(false);
    expect(isMergeKind({})).toBe(false);
  });

  it("does not require the prefix when only the description signal is present", () => {
    // Title does not start with `merge `, so `isMergeKind` returns false
    // even if description mentions `gh pr merge` — the design requires
    // the prefix on the title to qualify as a merge-kind issue.
    expect(
      isMergeKind({
        title: "Cleanup: review PR",
        description: "Will run gh pr merge after approval",
      }),
    ).toBe(false);
  });
});

describe("extractFeatureBranch", () => {
  it("captures the branch from 'merge <branch> to <target>'", () => {
    expect(extractFeatureBranch({ title: "Merge feature-x to main" })).toBe("feature-x");
    expect(extractFeatureBranch({ title: "merge NFM-3857-precompletion-merge-hook to main" })).toBe(
      "NFM-3857-precompletion-merge-hook",
    );
  });

  it("captures the branch from 'merge <branch> into <target>' and '... branch <target>'", () => {
    expect(extractFeatureBranch({ title: "Merge feature-y into dev" })).toBe("feature-y");
    expect(extractFeatureBranch({ title: "Merge feature-z branch qa" })).toBe("feature-z");
  });

  it("returns null when no branch is named", () => {
    expect(extractFeatureBranch({ title: "Merge changes" })).toBeNull();
    expect(extractFeatureBranch({ title: "Refactor ingestion" })).toBeNull();
    expect(extractFeatureBranch({})).toBeNull();
  });
});

describe("getMergeKindBlockReason", () => {
  beforeEach(() => {
    resetPrecompletionBypassCountForTesting();
  });

  afterEach(() => {
    resetPrecompletionBypassCountForTesting();
  });

  const baseIssue = {
    id: "issue-1",
    title: "Merge NFM-3857-precompletion-merge-hook to main",
    description: null,
    executionWorkspaceId: "ws-1",
  };

  const baseWorkspace = { workspacePath: "/tmp/repo", branchName: "main" };

  it("T0: returns merge_kind_unmerged_branch when ancestor check fails", async () => {
    const runGit = syntheticRunGit({
      "merge-base --is-ancestor NFM-3857-precompletion-merge-hook origin/main": { rc: 1 },
    });
    const block = await getMergeKindBlockReason({
      issue: baseIssue,
      workspace: baseWorkspace,
      options: { hookEnabled: true, actorType: "agent", runGit },
    });
    expect(block).not.toBeNull();
    expect(block!.code).toBe("merge_kind_unmerged_branch");
    expect(block!.branch).toBe("NFM-3857-precompletion-merge-hook");
    expect(block!.evidence_command).toContain("git -C /tmp/repo merge-base --is-ancestor");
    expect(block!.hint).toMatch(/NFM-3857-precompletion-merge-hook/);
  });

  it("T1: system actor bypasses the gate AND increments bypass counter", async () => {
    // No git call expected — system actor short-circuits before any
    // merge-base invocation. We use a sentinel that throws if invoked.
    const runGit: RunGitFn = async () => {
      throw new Error("system actor must not invoke git");
    };
    const block = await getMergeKindBlockReason({
      issue: baseIssue,
      workspace: baseWorkspace,
      options: { hookEnabled: true, actorType: "system", runGit },
    });
    expect(block).toBeNull();

    // Caller-side bookkeeping for the system bypass.
    const before = getPrecompletionBypassCount();
    const audit = recordSystemBypass({
      issue: { id: baseIssue.id, title: baseIssue.title },
      branch: "NFM-3857-precompletion-merge-hook",
      actorId: "system-actor-1",
    });
    expect(audit?.action).toBe("issue.precompletion_bypass");
    expect(audit?.details.branch).toBe("NFM-3857-precompletion-merge-hook");
    expect(getPrecompletionBypassCount()).toBe(before + 1);
    expect(incrementPrecompletionBypass()).toBe(before + 2);
  });

  it("T2: non-merge-kind issues pass through with no metric", async () => {
    const runGit: RunGitFn = async () => {
      throw new Error("non-merge-kind must not invoke git");
    };
    const block = await getMergeKindBlockReason({
      issue: {
        id: "issue-2",
        title: "Refactor ingestion worker",
        description: null,
        executionWorkspaceId: "ws-1",
      },
      workspace: baseWorkspace,
      options: { hookEnabled: true, actorType: "agent", runGit },
    });
    expect(block).toBeNull();
    expect(getPrecompletionBypassCount()).toBe(0);
  });

  it("T3: merge-kind issue with branch already ancestor of main → pass-through", async () => {
    const runGit = syntheticRunGit({
      "merge-base --is-ancestor NFM-3857-precompletion-merge-hook origin/main": { rc: 0 },
    });
    const block = await getMergeKindBlockReason({
      issue: baseIssue,
      workspace: baseWorkspace,
      options: { hookEnabled: true, actorType: "agent", runGit },
    });
    expect(block).toBeNull();
  });

  it("returns merge_kind_no_workspace when executionWorkspaceId is null", async () => {
    const runGit: RunGitFn = async () => {
      throw new Error("must not invoke git when workspace is missing");
    };
    const block = await getMergeKindBlockReason({
      issue: { ...baseIssue, executionWorkspaceId: null },
      workspace: null,
      options: { hookEnabled: true, actorType: "agent", runGit },
    });
    expect(block).not.toBeNull();
    expect(block!.code).toBe("merge_kind_no_workspace");
    expect(block!.branch).toBe("NFM-3857-precompletion-merge-hook");
  });

  it("returns merge_kind_missing_branch when title has no extractable branch", async () => {
    // Title qualifies as merge-kind (`^merge\s` + `to main`) but the
    // branch-extractor needs `merge <branch> (to|into|branch)` with a
    // non-space branch token between `merge` and the connector. "Merge to
    // main" has no such token, so extractFeatureBranch returns null while
    // isMergeKind returns true.
    const runGit: RunGitFn = async () => {
      throw new Error("must not invoke git when branch is missing");
    };
    const block = await getMergeKindBlockReason({
      issue: { ...baseIssue, title: "Merge to main" },
      workspace: baseWorkspace,
      options: { hookEnabled: true, actorType: "agent", runGit },
    });
    expect(block).not.toBeNull();
    expect(block!.code).toBe("merge_kind_missing_branch");
    expect(block!.branch).toBeUndefined();
  });

  it("hookEnabled=false → no-op even for merge-kind issues", async () => {
    const runGit: RunGitFn = async () => {
      throw new Error("flag-off must not invoke git");
    };
    const block = await getMergeKindBlockReason({
      issue: baseIssue,
      workspace: baseWorkspace,
      options: { hookEnabled: false, actorType: "agent", runGit },
    });
    expect(block).toBeNull();
  });

  it("honours a custom baseRef override", async () => {
    const runGit = syntheticRunGit({
      "merge-base --is-ancestor NFM-3857-precompletion-merge-hook upstream/main": { rc: 1 },
    });
    const block = await getMergeKindBlockReason({
      issue: baseIssue,
      workspace: baseWorkspace,
      options: {
        hookEnabled: true,
        actorType: "agent",
        baseRef: "upstream/main",
        runGit,
      },
    });
    expect(block).not.toBeNull();
    expect(block!.code).toBe("merge_kind_unmerged_branch");
    expect(block!.evidence_command).toContain("upstream/main");
    expect(block!.hint).toContain("upstream/main");
  });
});
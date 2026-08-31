import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isMergeKind,
  extractFeatureBranch,
  checkBranchAncestry,
  createPrecompletionBridgeGuard,
  type RunGitFn,
} from "./precompletion-bridge-guard.js";

// ---------------------------------------------------------------------------
// isMergeKind — mirrors server hook tests (NFM-3857 T1-T3)
// ---------------------------------------------------------------------------

describe("isMergeKind", () => {
  it("returns false for non-merge titles", () => {
    expect(isMergeKind("fix the login bug", "")).toBe(false);
    expect(isMergeKind("Implement feature X", "no merge here")).toBe(false);
    expect(isMergeKind("", "")).toBe(false);
  });

  it("returns true for 'merge X to (origin/)main' title", () => {
    expect(isMergeKind("Merge feat/foo to main", "")).toBe(true);
    expect(isMergeKind("MERGE feat/foo TO origin/main", "")).toBe(true);
  });

  it("returns false for 'merge X into/branch main' (only 'to' in MERGE_TITLE_TO_MAIN)", () => {
    // NOTE: 'into' and 'branch' are recognized by BRANCH_EXTRACTOR
    // but NOT by MERGE_TITLE_TO_MAIN, matching the server hook.
    expect(isMergeKind("merge feat/foo into main", "")).toBe(false);
    expect(isMergeKind("Merge feat/foo branch main", "")).toBe(false);
  });

  it("returns true when title has merge prefix and description has gh pr merge", () => {
    expect(isMergeKind("Merge the PR", "ran gh pr merge --squash")).toBe(true);
    expect(isMergeKind("Merge stuff", "after: gh PR merge done")).toBe(true);
  });

  it("returns false for merge prefix without to-main or gh pr merge", () => {
    expect(isMergeKind("Merge conflict resolution steps", "")).toBe(false);
    expect(isMergeKind("Merge review feedback", "")).toBe(false);
  });

  it("is case-insensitive for merge prefix", () => {
    expect(isMergeKind("MERGE feat/bar to main", "")).toBe(true);
    expect(isMergeKind("merge feat/bar to main", "")).toBe(true);
    expect(isMergeKind("Merge feat/bar to main", "")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractFeatureBranch
// ---------------------------------------------------------------------------

describe("extractFeatureBranch", () => {
  it("extracts branch from 'merge X to Y'", () => {
    expect(extractFeatureBranch("Merge feat/foo to main")).toBe("feat/foo");
    expect(extractFeatureBranch("merge feat/bar into main")).toBe("feat/bar");
    expect(extractFeatureBranch("MERGE fix/123 branch main")).toBe("fix/123");
  });

  it("returns null for non-merge titles", () => {
    expect(extractFeatureBranch("Fix the bug")).toBeNull();
    expect(extractFeatureBranch("")).toBeNull();
  });

  it("returns null when branch is missing after merge keyword", () => {
    expect(extractFeatureBranch("Merge to main")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkBranchAncestry
// ---------------------------------------------------------------------------

describe("checkBranchAncestry", () => {
  it("returns true when git merge-base exits 0", async () => {
    const mockGit = vi.fn<RunGitFn>().mockResolvedValue({ stdout: "", stderr: "" });
    const result = await checkBranchAncestry({
      branch: "feat/foo",
      workspacePath: "/tmp/test",
      runGit: mockGit,
    });
    expect(result).toBe(true);
    expect(mockGit).toHaveBeenCalledWith(
      ["merge-base", "--is-ancestor", "feat/foo", "origin/main"],
      "/tmp/test",
    );
  });

  it("returns false when git merge-base exits 1", async () => {
    const mockGit = vi.fn<RunGitFn>().mockRejectedValue({ code: 1 });
    const result = await checkBranchAncestry({
      branch: "feat/foo",
      workspacePath: "/tmp/test",
      runGit: mockGit,
    });
    expect(result).toBe(false);
  });

  it("returns true (fail-open) when git exits with unexpected code", async () => {
    const mockGit = vi.fn<RunGitFn>().mockRejectedValue({ code: 127 });
    const result = await checkBranchAncestry({
      branch: "feat/foo",
      workspacePath: "/tmp/test",
      runGit: mockGit,
    });
    expect(result).toBe(true);
  });

  it("returns true (fail-open) when git throws non-error", async () => {
    const mockGit = vi.fn<RunGitFn>().mockRejectedValue(new Error("ENOENT"));
    const result = await checkBranchAncestry({
      branch: "feat/foo",
      workspacePath: "/tmp/test",
      runGit: mockGit,
    });
    expect(result).toBe(true);
  });

  it("respects baseRef parameter", async () => {
    const mockGit = vi.fn<RunGitFn>().mockResolvedValue({ stdout: "", stderr: "" });
    await checkBranchAncestry({
      branch: "feat/foo",
      workspacePath: "/tmp/test",
      baseRef: "origin/develop",
      runGit: mockGit,
    });
    expect(mockGit).toHaveBeenCalledWith(
      ["merge-base", "--is-ancestor", "feat/foo", "origin/develop"],
      "/tmp/test",
    );
  });
});

// ---------------------------------------------------------------------------
// createPrecompletionBridgeGuard - integration tests
// ---------------------------------------------------------------------------

describe("createPrecompletionBridgeGuard", () => {
  const mockFetch = vi.fn();
  const mockGit = vi.fn<RunGitFn>();

  function makeGuard(opts?: { fetchFn?: typeof fetch; runGit?: RunGitFn }) {
    return createPrecompletionBridgeGuard({
      apiUrl: "http://localhost:3101",
      apiToken: "test-token",
      workspacePath: "/workspace",
      runId: "test-run-id",
      fetchFn: opts?.fetchFn ?? mockFetch,
      runGit: opts?.runGit ?? mockGit,
    });
  }

  beforeEach(() => {
    mockFetch.mockReset();
    mockGit.mockReset();
  });

  it("allows through non-PATCH requests", async () => {
    const guard = makeGuard();
    const result = await guard.intercept({ method: "GET", path: "/api/issues/abc" });
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("allows through PATCH to non-issues path", async () => {
    const guard = makeGuard();
    const result = await guard.intercept({
      method: "PATCH",
      path: "/api/agents/me",
      body: JSON.stringify({ status: "done" }),
    });
    expect(result).toBeNull();
  });

  it("allows through PATCH with non-done status", async () => {
    const guard = makeGuard();
    const result = await guard.intercept({
      method: "PATCH",
      path: "/api/issues/abc-123",
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(result).toBeNull();
  });

  it("allows through when feature flag is off", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ precompletionMergeHookEnabled: false }),
    });
    const guard = makeGuard();
    const result = await guard.intercept({
      method: "PATCH",
      path: "/api/issues/abc-123",
      body: JSON.stringify({ status: "done" }),
    });
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("allows through when flag fetch fails (fail-open)", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));
    const guard = makeGuard();
    const result = await guard.intercept({
      method: "PATCH",
      path: "/api/issues/abc-123",
      body: JSON.stringify({ status: "done" }),
    });
    expect(result).toBeNull();
  });

  it("allows through when flag fetch returns non-OK (fail-open)", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    const guard = makeGuard();
    const result = await guard.intercept({
      method: "PATCH",
      path: "/api/issues/abc-123",
      body: JSON.stringify({ status: "done" }),
    });
    expect(result).toBeNull();
  });

  it("allows through for non-merge-kind issue when flag is on", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ precompletionMergeHookEnabled: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "abc-123",
          title: "Fix the login bug",
          description: "",
        }),
      });
    const guard = makeGuard();
    const result = await guard.intercept({
      method: "PATCH",
      path: "/api/issues/abc-123",
      body: JSON.stringify({ status: "done" }),
    });
    expect(result).toBeNull();
  });

  it("blocks merge-kind issue with unmerged branch", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ precompletionMergeHookEnabled: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "abc-123",
          title: "Merge feat/foo to main",
          description: "",
        }),
      });
    mockGit.mockRejectedValue({ code: 1 });
    const guard = makeGuard();
    const result = await guard.intercept({
      method: "PATCH",
      path: "/api/issues/abc-123",
      body: JSON.stringify({ status: "done" }),
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(422);
    const body = JSON.parse(result!.body);
    expect(body.code).toBe("merge_kind_unmerged_branch");
    expect(body.branch).toBe("feat/foo");
  });

  it("allows merge-kind issue with merged branch", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ precompletionMergeHookEnabled: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "abc-123",
          title: "Merge feat/foo to main",
          description: "",
        }),
      });
    mockGit.mockResolvedValue({ stdout: "", stderr: "" });
    const guard = makeGuard();
    const result = await guard.intercept({
      method: "PATCH",
      path: "/api/issues/abc-123",
      body: JSON.stringify({ status: "done" }),
    });
    expect(result).toBeNull();
  });

  it("blocks merge-kind issue with missing branch extraction", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ precompletionMergeHookEnabled: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "abc-123",
          title: "Merge to main",
          description: "",
        }),
      });
    const guard = makeGuard();
    const result = await guard.intercept({
      method: "PATCH",
      path: "/api/issues/abc-123",
      body: JSON.stringify({ status: "done" }),
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(422);
    const body = JSON.parse(result!.body);
    expect(body.code).toBe("merge_kind_missing_branch");
  });

  it("allows through when issue fetch fails (fail-open)", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ precompletionMergeHookEnabled: true }),
      })
      .mockRejectedValueOnce(new Error("timeout"));
    const guard = makeGuard();
    const result = await guard.intercept({
      method: "PATCH",
      path: "/api/issues/abc-123",
      body: JSON.stringify({ status: "done" }),
    });
    expect(result).toBeNull();
  });

  it("caches the feature flag for the guard lifetime", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ precompletionMergeHookEnabled: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "abc-123",
          title: "Fix bug",
          description: "",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "def-456",
          title: "Another fix",
          description: "",
        }),
      });
    const guard = makeGuard();
    await guard.intercept({
      method: "PATCH",
      path: "/api/issues/abc-123",
      body: JSON.stringify({ status: "done" }),
    });
    await guard.intercept({
      method: "PATCH",
      path: "/api/issues/def-456",
      body: JSON.stringify({ status: "done" }),
    });
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 flag + 2 issues
  });

  it("passes correct API headers including run ID", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ precompletionMergeHookEnabled: false }),
    });
    const guard = makeGuard();
    await guard.intercept({
      method: "PATCH",
      path: "/api/issues/abc-123",
      body: JSON.stringify({ status: "done" }),
    });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/instance/settings/experimental");
    expect(opts.headers.authorization).toBe("Bearer test-token");
    expect(opts.headers["x-paperclip-run-id"]).toBe("test-run-id");
  });

  it("handles 422 response body structure correctly", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ precompletionMergeHookEnabled: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "abc-123",
          title: "Merge feat/bar to main",
          description: "",
        }),
      });
    mockGit.mockRejectedValue({ code: 1 });
    const guard = makeGuard();
    const result = await guard.intercept({
      method: "PATCH",
      path: "/api/issues/abc-123",
      body: JSON.stringify({ status: "done" }),
    });
    const body = JSON.parse(result!.body);
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("code");
    expect(body).toHaveProperty("branch", "feat/bar");
  });
});

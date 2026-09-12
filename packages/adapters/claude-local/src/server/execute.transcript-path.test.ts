import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runAdapterExecutionTargetProcess = vi.hoisted(() =>
  vi.fn(async (
    _runId: string,
    _target: unknown,
    _command: string,
    _args: string[],
    options: {
      onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
    },
  ) => {
    if (options.onSpawn) {
      await options.onSpawn({ pid: 4242, processGroupId: 4242, startedAt: new Date().toISOString() });
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
        JSON.stringify({
          type: "result",
          session_id: "claude-session-1",
          subtype: "success",
          result: "ok",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
        }),
      ].join("\n"),
      stderr: "",
    };
  }),
);

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

type SpawnMeta = {
  pid: number;
  processGroupId: number | null;
  startedAt: string;
  transcriptPath?: string | null;
};

describe("claude-local adapter transcript path reporting at adapter start", () => {
  const cleanupDirs: string[] = [];
  const sessionId = "9d01a2b3-1111-2222-3333-444455556666";

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runExecute(opts: {
    onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string; transcriptPath?: string | null }) => Promise<void>;
    runtimeSessionId?: string | null;
  }) {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "nfm4784-claude-cwd-"));
    cleanupDirs.push(workspaceDir);
    const configDir = await mkdtemp(path.join(os.tmpdir(), "nfm4784-claude-config-"));
    cleanupDirs.push(configDir);

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: opts.runtimeSessionId ?? null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        cwd: workspaceDir,
        env: {
          CLAUDE_CONFIG_DIR: configDir,
        },
      },
      context: {},
      onLog: async () => {},
      ...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
    });

    return { workspaceDir, configDir };
  }

  it("reports the session transcript file path on spawn when resuming a known session", async () => {
    const onSpawn = vi.fn(async (_meta: SpawnMeta) => {});
    const { workspaceDir, configDir } = await runExecute({
      onSpawn,
      runtimeSessionId: sessionId,
    });

    expect(onSpawn).toHaveBeenCalledTimes(1);
    const meta = onSpawn.mock.calls[0]![0];
    const encodedCwd = workspaceDir.replace(/[^a-zA-Z0-9-]/g, "-");
    expect(meta.transcriptPath).toBe(
      path.join(configDir, "projects", encodedCwd, `${sessionId}.jsonl`),
    );
  });

  it("reports the project transcript directory on spawn when the session id is not yet known", async () => {
    const onSpawn = vi.fn(async (_meta: SpawnMeta) => {});
    const { workspaceDir, configDir } = await runExecute({
      onSpawn,
      runtimeSessionId: null,
    });

    expect(onSpawn).toHaveBeenCalledTimes(1);
    const meta = onSpawn.mock.calls[0]![0];
    const encodedCwd = workspaceDir.replace(/[^a-zA-Z0-9-]/g, "-");
    expect(meta.transcriptPath).toBe(path.join(configDir, "projects", encodedCwd));
  });
});

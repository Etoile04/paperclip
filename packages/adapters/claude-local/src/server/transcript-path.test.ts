import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveClaudeSessionTranscriptPaths } from "./execute.js";

describe("resolveClaudeSessionTranscriptPaths", () => {
  it("resolves the exact session transcript file when the session id is known", () => {
    const resolved = resolveClaudeSessionTranscriptPaths({
      env: { CLAUDE_CONFIG_DIR: "/tmp/claude-config" },
      executionCwd: "/Users/dev/Projects/app",
      sessionId: "9d01a2b3-1111-2222-3333-444455556666",
    });
    expect(resolved.scope).toBe("session_file");
    expect(resolved.transcriptPath).toBe(
      path.join(
        "/tmp/claude-config",
        "projects",
        "-Users-dev-Projects-app",
        "9d01a2b3-1111-2222-3333-444455556666.jsonl",
      ),
    );
  });

  it("falls back to the project directory when the session id is not yet known", () => {
    const resolved = resolveClaudeSessionTranscriptPaths({
      env: { CLAUDE_CONFIG_DIR: "/tmp/claude-config" },
      executionCwd: "/Users/dev/Projects/app",
      sessionId: null,
    });
    expect(resolved.scope).toBe("project_dir");
    expect(resolved.transcriptPath).toBe(
      path.join("/tmp/claude-config", "projects", "-Users-dev-Projects-app"),
    );
  });

  it("defaults the config dir to ~/.claude when CLAUDE_CONFIG_DIR is unset", () => {
    const resolved = resolveClaudeSessionTranscriptPaths({
      env: {},
      executionCwd: "/srv/work",
      sessionId: null,
    });
    expect(resolved.transcriptPath).toBe(
      path.join(os.homedir(), ".claude", "projects", "-srv-work"),
    );
  });

  it("mirrors Claude Code's project-dir encoding for non-alphanumeric path characters", () => {
    const resolved = resolveClaudeSessionTranscriptPaths({
      env: { CLAUDE_CONFIG_DIR: "/tmp/claude-config" },
      executionCwd: "/Users/dev.name/my_projects (work)",
      sessionId: null,
    });
    // Each non-alphanumeric character maps 1:1 to a single dash: "/" ".", "_"
    // each become "-", and the " (" pair plus trailing ")" produce "--work-".
    expect(resolved.transcriptPath).toBe(
      path.join("/tmp/claude-config", "projects", "-Users-dev-name-my-projects--work-"),
    );
  });
});

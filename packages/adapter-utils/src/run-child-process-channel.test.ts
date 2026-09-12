import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runChildProcess, runningProcesses } from "./server-utils.js";

type ChannelSeverance = {
  stream: "stdout" | "stderr";
  childPid: number | null;
  reason: string;
};

describe("runChildProcess channel severance (reader-stream death)", () => {
  it("reports channel severed exactly once when a reader stream dies while the child may still be alive", async () => {
    const runId = randomUUID();
    const severances: ChannelSeverance[] = [];
    const onChannelSevered = vi.fn(async (meta: ChannelSeverance) => {
      severances.push(meta);
    });

    const runPromise = runChildProcess(runId, process.execPath, ["-e", "setTimeout(() => {}, 800)"], {
      cwd: process.cwd(),
      env: {},
      timeoutSec: 10,
      graceSec: 1,
      onLog: async () => {},
      onChannelSevered,
    });

    // Wait until the child is registered so we can simulate a reader-stream
    // death on the harness side while the child process is still running.
    let registered = runningProcesses.get(runId);
    for (let attempt = 0; attempt < 100 && !registered; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      registered = runningProcesses.get(runId);
    }
    expect(registered).toBeTruthy();
    const child = registered!.child;
    expect(typeof child.pid).toBe("number");

    child.stdout?.emit("error", new Error("read ECONNRESET"));
    child.stdout?.emit("error", new Error("read ECONNRESET (repeat)"));
    child.stderr?.emit("error", new Error("read EPIPE"));

    const result = await runPromise;
    expect(result.exitCode).toBe(0);

    expect(onChannelSevered).toHaveBeenCalledTimes(1);
    expect(severances[0]?.stream).toBe("stdout");
    expect(severances[0]?.childPid).toBe(child.pid ?? null);
    expect(severances[0]?.reason).toContain("ECONNRESET");
  });

  it("does not report channel severed after the child has exited", async () => {
    const runId = randomUUID();
    const onChannelSevered = vi.fn(async () => {});

    const result = await runChildProcess(runId, process.execPath, ["-e", "process.exit(0)"], {
      cwd: process.cwd(),
      env: {},
      timeoutSec: 10,
      graceSec: 1,
      onLog: async () => {},
      onChannelSevered,
    });
    expect(result.exitCode).toBe(0);

    // The registration is gone once the child closes; a late stream error on
    // the retained child object must not be reported as a severance because
    // the child is provably gone (positive death evidence).
    expect(runningProcesses.has(runId)).toBe(false);
    expect(onChannelSevered).not.toHaveBeenCalled();
  });

  it("does not report channel severed when no callback is provided", async () => {
    const runId = randomUUID();

    const runPromise = runChildProcess(runId, process.execPath, ["-e", "setTimeout(() => {}, 500)"], {
      cwd: process.cwd(),
      env: {},
      timeoutSec: 10,
      graceSec: 1,
      onLog: async () => {},
    });

    let registered = runningProcesses.get(runId);
    for (let attempt = 0; attempt < 100 && !registered; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      registered = runningProcesses.get(runId);
    }
    // No onChannelSevered callback configured — the emission must be a no-op.
    registered!.child.stdout?.emit("error", new Error("read ECONNRESET"));

    const result = await runPromise;
    expect(result.exitCode).toBe(0);
  });
});

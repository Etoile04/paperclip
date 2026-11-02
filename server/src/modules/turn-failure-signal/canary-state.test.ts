import { describe, expect, it } from "vitest";
import { DEFAULT_CANARY_MAX_AGE_MS, readCanaryState } from "./canary-state.js";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const FRESH = NOW - 60 * 1000;

function deps(raw: string | null, mtime: number = FRESH) {
  return {
    deps: {
      readFile: () => {
        if (raw === null) throw new Error("ENOENT");
        return raw;
      },
      mtimeMs: () => {
        if (Number.isNaN(mtime)) throw new Error("ENOENT");
        return mtime;
      },
    },
  };
}

describe("readCanaryState", () => {
  it("reads green from the live canary state file", () => {
    const observation = readCanaryState("/state/provider_canary_state.json", {
      now: NOW,
      ...deps(
        JSON.stringify({
          consecutive_failures: 0,
          critical_issue_id: null,
          episode_open: false,
          first_red_at: null,
          last_restate_at: null,
          pending_recovery: [],
        }),
      ),
    });
    expect(observation.state).toBe("green");
  });

  it("reads red from an open episode", () => {
    const observation = readCanaryState("/state/provider_canary_state.json", {
      now: NOW,
      ...deps(
        JSON.stringify({
          consecutive_failures: 2,
          episode_open: true,
          first_red_at: "2026-10-26T11:00:00.000Z",
        }),
      ),
    });
    expect(observation.state).toBe("red");
  });

  it("reads red from consecutive failures even before the episode opens", () => {
    const observation = readCanaryState("/state/provider_canary_state.json", {
      now: NOW,
      ...deps(JSON.stringify({ consecutive_failures: 1, episode_open: false })),
    });
    expect(observation.state).toBe("red");
  });

  it("treats a missing file as unknown — never as green", () => {
    const observation = readCanaryState("/state/provider_canary_state.json", {
      now: NOW,
      ...deps(null),
    });
    expect(observation.state).toBe("unknown");
  });

  it("treats malformed JSON as unknown", () => {
    const observation = readCanaryState("/state/provider_canary_state.json", {
      now: NOW,
      ...deps("{not json"),
    });
    expect(observation.state).toBe("unknown");
  });

  it("treats a non-object payload as unknown", () => {
    const observation = readCanaryState("/state/provider_canary_state.json", {
      now: NOW,
      ...deps(JSON.stringify(["red"])),
    });
    expect(observation.state).toBe("unknown");
  });

  it("treats a stale file as unknown — a silent probe cannot confirm green", () => {
    const observation = readCanaryState("/state/provider_canary_state.json", {
      now: NOW,
      maxAgeMs: DEFAULT_CANARY_MAX_AGE_MS,
      ...deps(JSON.stringify({ consecutive_failures: 0, episode_open: false }), NOW - 3 * 60 * 60 * 1000),
    });
    expect(observation.state).toBe("unknown");
  });

  it("accepts a file within the staleness bound", () => {
    const observation = readCanaryState("/state/provider_canary_state.json", {
      now: NOW,
      maxAgeMs: DEFAULT_CANARY_MAX_AGE_MS,
      ...deps(JSON.stringify({ consecutive_failures: 0, episode_open: false }), NOW - 90 * 60 * 1000),
    });
    expect(observation.state).toBe("green");
  });

  it("treats non-numeric counters as unknown", () => {
    const observation = readCanaryState("/state/provider_canary_state.json", {
      now: NOW,
      ...deps(JSON.stringify({ consecutive_failures: "zero", episode_open: false })),
    });
    expect(observation.state).toBe("unknown");
  });

  it("treats a missing episode_open flag as unknown", () => {
    const observation = readCanaryState("/state/provider_canary_state.json", {
      now: NOW,
      ...deps(JSON.stringify({ consecutive_failures: 0 })),
    });
    expect(observation.state).toBe("unknown");
  });
});

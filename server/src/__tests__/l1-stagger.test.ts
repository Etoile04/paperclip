import { describe, it, expect } from "vitest";

import {
  agentStaggerOffsetMs,
  applyL1Stagger,
} from "../services/l1-stagger.js";
import { HEARTBEAT_JITTER_MINUTES } from "../services/fleet-throttle-constants.js";

const MS_PER_MINUTE = 60_000;

describe("l1-stagger (ADR-014 §3 L1)", () => {
  it("returns a deterministic offset for a fixed agentId", () => {
    const agentId = "agent-1234-abcdef";
    const a = agentStaggerOffsetMs(agentId);
    const b = agentStaggerOffsetMs(agentId);
    const c = agentStaggerOffsetMs(agentId);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("returns differing offsets for distinct agentIds (statistical)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      seen.add(agentStaggerOffsetMs(`agent-${i.toString().padStart(4, "0")}`).toString());
    }
    // SHA-1 across 50 inputs should give essentially 50 unique offsets.
    expect(seen.size).toBeGreaterThan(45);
  });

  it("keeps the offset inside the ±HEARTBEAT_JITTER_MINUTES band", () => {
    for (let i = 0; i < 200; i += 1) {
      const offset = agentStaggerOffsetMs(`agent-${i}`);
      const limit = HEARTBEAT_JITTER_MINUTES * MS_PER_MINUTE;
      expect(Math.abs(offset)).toBeLessThanOrEqual(limit);
    }
  });

  it("applyL1Stagger returns a Date offset by the agent's stable jitter", () => {
    const agentId = "stable-agent-id";
    const base = new Date("2026-09-11T07:30:00.000Z");
    const jittered = applyL1Stagger(base, agentId);
    expect(jittered.getTime() - base.getTime()).toBe(agentStaggerOffsetMs(agentId));
    // Same agent → same jitter across calls.
    expect(applyL1Stagger(base, agentId).getTime()).toBe(jittered.getTime());
  });

  it("applyL1Stagger preserves the input Date (immutability)", () => {
    const base = new Date("2026-09-11T07:30:00.000Z");
    const before = base.getTime();
    applyL1Stagger(base, "any-agent");
    expect(base.getTime()).toBe(before);
  });
});
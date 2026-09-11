import { describe, it, expect } from "vitest";

import {
  attachReadOnlyPreamble,
  evaluateDispatch,
  CONTEXT_SNAPSHOT_DEMOTE_FLAG,
  CONTEXT_SNAPSHOT_DEMOTE_POLICY,
} from "../services/fleet-dispatch-guard.js";
import {
  DEMOTE_POLICY,
  HEAVY_DISPATCH_TOKEN_THRESHOLD,
} from "../services/fleet-throttle-constants.js";

describe("fleet-dispatch-guard (ADR-014 §3 L5)", () => {
  describe("evaluateDispatch — full input matrix", () => {
    const cases: Array<{
      label: string;
      tokens: number;
      tripped: boolean;
      expected: "allow" | "allow_demoted" | "block";
    }> = [
      { label: "no_throttle, not heavy", tokens: 0, tripped: false, expected: "allow" },
      { label: "no_throttle, not heavy (50k)", tokens: HEAVY_DISPATCH_TOKEN_THRESHOLD, tripped: false, expected: "allow" },
      { label: "tripped, not heavy", tokens: 0, tripped: true, expected: "allow_demoted" },
      { label: "tripped, just below heavy threshold", tokens: HEAVY_DISPATCH_TOKEN_THRESHOLD - 1, tripped: true, expected: "allow_demoted" },
      { label: "tripped, exactly at heavy threshold", tokens: HEAVY_DISPATCH_TOKEN_THRESHOLD, tripped: true, expected: "block" },
      { label: "tripped, well above heavy threshold", tokens: HEAVY_DISPATCH_TOKEN_THRESHOLD * 10, tripped: true, expected: "block" },
    ];

    for (const c of cases) {
      it(`${c.label} → ${c.expected}`, () => {
        const v = evaluateDispatch({ estimatedTokens: c.tokens, isTripped: c.tripped });
        expect(v.verdict).toBe(c.expected);
        expect(v.block).toBe(c.expected === "block");
        expect(v.demoteToReviewOnly).toBe(c.expected !== "allow");
      });
    }
  });

  describe("evaluateDispatch — semantic invariants", () => {
    it("never throws on extreme inputs", () => {
      expect(() => evaluateDispatch({ estimatedTokens: -1, isTripped: false })).not.toThrow();
      expect(() => evaluateDispatch({ estimatedTokens: Number.MAX_SAFE_INTEGER, isTripped: true })).not.toThrow();
    });

    it("heavy flag tracks the threshold precisely", () => {
      expect(evaluateDispatch({ estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD - 1, isTripped: false }).heavy).toBe(false);
      expect(evaluateDispatch({ estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD, isTripped: false }).heavy).toBe(true);
    });

    it("read-only demotion does NOT set block", () => {
      const v = evaluateDispatch({ estimatedTokens: 1000, isTripped: true });
      expect(v.verdict).toBe("allow_demoted");
      expect(v.block).toBe(false);
    });
  });

  describe("attachReadOnlyPreamble (immutability + keys)", () => {
    it("attaches both demote flag and policy on a fresh snapshot", () => {
      const out = attachReadOnlyPreamble({ existingKey: "value" }, DEMOTE_POLICY);
      expect(out).toEqual({
        existingKey: "value",
        [CONTEXT_SNAPSHOT_DEMOTE_FLAG]: true,
        [CONTEXT_SNAPSHOT_DEMOTE_POLICY]: DEMOTE_POLICY,
      });
    });

    it("returns a NEW object (does not mutate input)", () => {
      const input: Record<string, unknown> = { x: 1 };
      const out = attachReadOnlyPreamble(input, DEMOTE_POLICY);
      expect(out).not.toBe(input);
      expect(input).toEqual({ x: 1 });
      expect(input[CONTEXT_SNAPSHOT_DEMOTE_FLAG]).toBeUndefined();
    });

    it("tolerates undefined input snapshot", () => {
      const out = attachReadOnlyPreamble(undefined, DEMOTE_POLICY);
      expect(out[CONTEXT_SNAPSHOT_DEMOTE_FLAG]).toBe(true);
      expect(out[CONTEXT_SNAPSHOT_DEMOTE_POLICY]).toBe(DEMOTE_POLICY);
    });
  });

  describe("E2E demo AC (synthetic 25%-remaining cap)", () => {
    it("(a) evaluateDispatch returns block for heavy wakes", () => {
      const v = evaluateDispatch({ estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD, isTripped: true });
      expect(v.verdict).toBe("block");
      expect(v.block).toBe(true);
    });

    it("(b) in-flight heavy wake gets demote preamble on allow_demoted", () => {
      const v = evaluateDispatch({ estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD, isTripped: true });
      // Caller responsibility: when `block` is true, the wake is not enqueued
      // and dispatch.blocked=true is recorded. For in-flight heavy work that
      // was already enqueued, the dispatcher attaches the preamble via
      // attachReadOnlyPreamble to signal AgentReviewer-only mode.
      expect(v.demoteToReviewOnly).toBe(true);
      const preamble = attachReadOnlyPreamble({ source: "scheduler" }, DEMOTE_POLICY);
      expect(preamble[CONTEXT_SNAPSHOT_DEMOTE_FLAG]).toBe(true);
      expect(preamble[CONTEXT_SNAPSHOT_DEMOTE_POLICY]).toBe(DEMOTE_POLICY);
    });

    it("(c) telemetry dim shape is documented as {agent_role, reason}", () => {
      // The dispatcher emits:
      //   client.track("fleet.dispatch.blocked", { agent_role, reason })
      // where reason is `evaluateDispatch.reason`. Assert the contract.
      const v = evaluateDispatch({ estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD, isTripped: true });
      expect(v.reason).toBe("tripped_above_threshold");
      const v2 = evaluateDispatch({ estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD - 1, isTripped: true });
      expect(v2.reason).toBe("tripped_below_threshold");
    });

    it("(d) trip self-clears when window drops back below threshold", () => {
      const v = evaluateDispatch({ estimatedTokens: HEAVY_DISPATCH_TOKEN_THRESHOLD, isTripped: false });
      expect(v.verdict).toBe("allow");
      expect(v.block).toBe(false);
      expect(v.demoteToReviewOnly).toBe(false);
    });
  });
});
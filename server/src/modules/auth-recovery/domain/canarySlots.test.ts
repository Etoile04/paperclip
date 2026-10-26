import { describe, expect, it } from "vitest";
import {
  CANARY_DEFAULT_SLOT_ID,
  CANARY_RED_THRESHOLD,
  applyCanaryProbe,
  classifyCanaryFleet,
  emptyCanaryFleetState,
  isSlotRed,
  migrateLegacyCanaryState,
  parseCanaryFleetState,
  redSlots,
  serializeCanaryFleetState,
  type CanaryFleetState,
} from "./canarySlots.js";

const T1 = "2026-10-26T09:00:00.000Z";
const T2 = "2026-10-26T09:01:00.000Z";
const T3 = "2026-10-26T09:02:00.000Z";
const T4 = "2026-10-26T09:03:00.000Z";

function probe(slotId: string, ok: boolean, at: string) {
  return { slotId, ok, at };
}

function fleetWith(...slots: Array<Partial<Parameters<typeof applyCanaryProbe>[1]> & { slotId: string }>): CanaryFleetState {
  return slots.reduce<CanaryFleetState>(
    (state, slot) => applyCanaryProbe(state, probe(slot.slotId, slot.ok ?? false, slot.at ?? T2)),
    emptyCanaryFleetState(),
  );
}

describe("per-slot canary probe state (ADR-026 §6)", () => {
  it("stays green after a single failure (WARN zone, no episode)", () => {
    const state = applyCanaryProbe(emptyCanaryFleetState(), probe(CANARY_DEFAULT_SLOT_ID, false, T1));
    expect(state.slots[CANARY_DEFAULT_SLOT_ID]).toEqual({
      slotId: CANARY_DEFAULT_SLOT_ID,
      consecutiveFailures: 1,
      episodeOpen: false,
      firstRedAt: null,
    });
    expect(isSlotRed(state, CANARY_DEFAULT_SLOT_ID)).toBe(false);
  });

  it("opens the slot episode at the red threshold with the first-red timestamp", () => {
    let state = applyCanaryProbe(emptyCanaryFleetState(), probe(CANARY_DEFAULT_SLOT_ID, false, T1));
    state = applyCanaryProbe(state, probe(CANARY_DEFAULT_SLOT_ID, false, T2));
    expect(state.slots[CANARY_DEFAULT_SLOT_ID]).toEqual({
      slotId: CANARY_DEFAULT_SLOT_ID,
      consecutiveFailures: CANARY_RED_THRESHOLD,
      episodeOpen: true,
      firstRedAt: T2,
    });
    expect(isSlotRed(state, CANARY_DEFAULT_SLOT_ID)).toBe(true);
  });

  it("keeps the episode-open first-red timestamp across sustained red", () => {
    let state = fleetWith({ slotId: "A", ok: false, at: T1 }, { slotId: "A", ok: false, at: T2 });
    state = applyCanaryProbe(state, probe("A", false, T3));
    expect(state.slots.A?.consecutiveFailures).toBe(3);
    expect(state.slots.A?.firstRedAt).toBe(T2);
  });

  it("closes the slot episode and resets the count on green", () => {
    let state = fleetWith({ slotId: "A", ok: false, at: T1 }, { slotId: "A", ok: false, at: T2 });
    state = applyCanaryProbe(state, probe("A", true, T3));
    expect(state.slots.A).toEqual({
      slotId: "A",
      consecutiveFailures: 0,
      episodeOpen: false,
      firstRedAt: null,
    });
    // One failure after green is the WARN zone again, not a red episode.
    state = applyCanaryProbe(state, probe("A", false, T4));
    expect(state.slots.A?.episodeOpen).toBe(false);
    expect(state.slots.A?.consecutiveFailures).toBe(1);
  });

  it("tracks slots independently (episodes are per-credential)", () => {
    let state = fleetWith({ slotId: "A", ok: false, at: T1 }, { slotId: "A", ok: false, at: T2 });
    state = applyCanaryProbe(state, probe("B", true, T2));
    expect(state.slots.A?.episodeOpen).toBe(true);
    expect(state.slots.B?.consecutiveFailures).toBe(0);
    state = applyCanaryProbe(state, probe("B", false, T3));
    expect(state.slots.B?.episodeOpen).toBe(false);
    expect(state.slots.A?.consecutiveFailures).toBe(2);
  });

  it("does not mutate the previous state (state-file writers rely on this)", () => {
    const before = fleetWith({ slotId: "A", ok: false, at: T1 }, { slotId: "A", ok: false, at: T2 });
    const snapshot = structuredClone(before);
    const after = applyCanaryProbe(before, probe("A", false, T3));
    expect(before).toEqual(snapshot);
    expect(after).not.toBe(before);
    expect(after.slots.A).not.toBe(before.slots.A);
  });

  it("rejects an empty slot id (slot ids are safe identifiers)", () => {
    expect(() => applyCanaryProbe(emptyCanaryFleetState(), probe("", false, T1))).toThrow();
    expect(() => applyCanaryProbe(emptyCanaryFleetState(), probe("  ", false, T1))).toThrow();
  });
});

describe("fleet classification (fleet-wide emergency = ALL registered slots red)", () => {
  it("classifies an empty registry as healthy (no probes, no alarm)", () => {
    expect(classifyCanaryFleet(emptyCanaryFleetState(), [])).toBe("healthy");
  });

  it("keeps the single-slot red in the legacy alarm class (N=1 no-regression)", () => {
    // With only slot A registered, all-red is today's ordinary [SRE-CRITICAL]
    // class — it must NOT escalate to the rarer fleet-wide emergency class.
    const state = fleetWith({ slotId: "A", ok: false, at: T1 }, { slotId: "A", ok: false, at: T2 });
    expect(classifyCanaryFleet(state, ["A"])).toBe("slot_red");
  });

  it("classifies one red slot among several as slot_red", () => {
    const state = applyCanaryProbe(
      fleetWith({ slotId: "A", ok: false, at: T1 }, { slotId: "A", ok: false, at: T2 }),
      probe("B", true, T2),
    );
    expect(classifyCanaryFleet(state, ["A", "B"])).toBe("slot_red");
    expect(classifyCanaryFleet(state, ["A", "B", "C"])).toBe("slot_red");
  });

  it("declares fleet-wide emergency only when every registered slot is red (N≥2)", () => {
    let state = fleetWith(
      { slotId: "A", ok: false, at: T1 },
      { slotId: "A", ok: false, at: T2 },
      { slotId: "B", ok: false, at: T1 },
      { slotId: "B", ok: false, at: T2 },
    );
    expect(classifyCanaryFleet(state, ["A", "B"])).toBe("fleet_emergency");
    // A third green slot de-escalates back to slot_red.
    state = applyCanaryProbe(state, probe("C", true, T3));
    expect(classifyCanaryFleet(state, ["A", "B", "C"])).toBe("slot_red");
  });

  it("ignores deregistered slots when classifying", () => {
    const state = fleetWith({ slotId: "X", ok: false, at: T1 }, { slotId: "X", ok: false, at: T2 });
    expect(classifyCanaryFleet(state, ["A"])).toBe("healthy");
    expect(redSlots(state, ["A"])).toEqual([]);
    expect(redSlots(state)).toEqual(["X"]);
  });

  it("lists registered red slots in registry order", () => {
    const state = fleetWith(
      { slotId: "B", ok: false, at: T1 },
      { slotId: "B", ok: false, at: T2 },
      { slotId: "A", ok: false, at: T1 },
      { slotId: "A", ok: false, at: T2 },
    );
    expect(redSlots(state, ["A", "B"])).toEqual(["A", "B"]);
  });
});

describe("legacy R1 state migration (NFM-5747 state file → per-slot)", () => {
  it("maps the single-slot R1 counters onto the default slot", () => {
    const state = migrateLegacyCanaryState({
      consecutiveFailures: CANARY_RED_THRESHOLD,
      episodeOpen: true,
      firstRedAt: T1,
    });
    expect(state.schemaVersion).toBe(1);
    expect(state.slots[CANARY_DEFAULT_SLOT_ID]).toEqual({
      slotId: CANARY_DEFAULT_SLOT_ID,
      consecutiveFailures: CANARY_RED_THRESHOLD,
      episodeOpen: true,
      firstRedAt: T1,
    });
  });

  it("derives a missing episodeOpen flag from the failure count", () => {
    const open = migrateLegacyCanaryState({ consecutiveFailures: 3 });
    expect(open.slots.A?.episodeOpen).toBe(true);
    expect(open.slots.A?.firstRedAt).toBeNull();
    const warn = migrateLegacyCanaryState({ consecutiveFailures: 1 });
    expect(warn.slots.A?.episodeOpen).toBe(false);
  });

  it("honors an explicit closed episode regardless of the count", () => {
    const state = migrateLegacyCanaryState({
      consecutiveFailures: 5,
      episodeOpen: false,
      firstRedAt: null,
    });
    expect(state.slots.A?.episodeOpen).toBe(false);
  });
});

describe("canary fleet state file parse/serialize", () => {
  it("round-trips a fleet state deterministically (sorted slot ids)", () => {
    const state = fleetWith(
      { slotId: "B", ok: false, at: T1 },
      { slotId: "B", ok: false, at: T2 },
      { slotId: "A", ok: true, at: T2 },
    );
    const text = serializeCanaryFleetState(state);
    expect(Object.keys(JSON.parse(text).slots)).toEqual(["A", "B"]);
    expect(parseCanaryFleetState(text)).toEqual(state);
  });

  it("accepts a minimal empty state file", () => {
    expect(parseCanaryFleetState('{"schemaVersion":1}')).toEqual(emptyCanaryFleetState());
    expect(parseCanaryFleetState({ schemaVersion: 1 })).toEqual(emptyCanaryFleetState());
  });

  it("rejects malformed state files", () => {
    expect(() => parseCanaryFleetState("not json")).toThrow();
    expect(() => parseCanaryFleetState([1, 2])).toThrow();
    expect(() => parseCanaryFleetState('{"schemaVersion":2}')).toThrow();
    expect(() => parseCanaryFleetState('{"schemaVersion":1,"slots":[]}')).toThrow();
    expect(() => parseCanaryFleetState('{"schemaVersion":1,"slots":{"A":{"slotId":"A","consecutiveFailures":-1,"episodeOpen":false,"firstRedAt":null}}}')).toThrow();
    expect(() => parseCanaryFleetState('{"schemaVersion":1,"slots":{"A":{"slotId":"A","consecutiveFailures":1.5,"episodeOpen":false,"firstRedAt":null}}}')).toThrow();
    expect(() => parseCanaryFleetState('{"schemaVersion":1,"slots":{"":{"slotId":"","consecutiveFailures":0,"episodeOpen":false,"firstRedAt":null}}}')).toThrow();
    expect(() => parseCanaryFleetState('{"schemaVersion":1,"slots":{"A":{"slotId":"B","consecutiveFailures":0,"episodeOpen":false,"firstRedAt":null}}}')).toThrow();
    expect(() => parseCanaryFleetState('{"schemaVersion":1,"slots":{"A":{"slotId":"A","consecutiveFailures":2,"episodeOpen":true,"firstRedAt":"nope"}}}')).toThrow();
    expect(() => parseCanaryFleetState('{"schemaVersion":1,"slots":{"A":{"slotId":"A","consecutiveFailures":2,"episodeOpen":true,"firstRedAt":null}}}')).toThrow();
    expect(() => parseCanaryFleetState('{"schemaVersion":1,"slots":{"A":{"slotId":"A","consecutiveFailures":1,"episodeOpen":true,"firstRedAt":"2026-10-26T09:00:00.000Z"}}}')).toThrow();
  });

  it("rejects unknown keys so no credential material can ride in state", () => {
    expect(() =>
      parseCanaryFleetState(
        '{"schemaVersion":1,"slots":{"A":{"slotId":"A","consecutiveFailures":2,"episodeOpen":true,"firstRedAt":null,"token":"sk-anything"}}}',
      ),
    ).toThrow();
    expect(() => parseCanaryFleetState('{"schemaVersion":1,"credential":"x"}')).toThrow();
    // The serializer's key set is a closed allowlist — nothing else can leak.
    const text = serializeCanaryFleetState(
      fleetWith({ slotId: "A", ok: false, at: T1 }, { slotId: "A", ok: false, at: T2 }),
    );
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed).sort()).toEqual(["schemaVersion", "slots"]);
    expect(Object.keys(parsed.slots.A).sort()).toEqual([
      "consecutiveFailures",
      "episodeOpen",
      "firstRedAt",
      "slotId",
    ]);
  });
});

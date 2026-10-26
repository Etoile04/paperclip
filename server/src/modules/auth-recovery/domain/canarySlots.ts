// NFM-5775 (ADR-026 §6) — per-slot canary episode state (pure decision layer).
// The provider canary (NFM-5747, R1) is the credential-liveness authority; its
// scratch state file grows from a single consecutive-fail counter to per-slot
// consecutive-fail counts + per-slot episode-open flags so episodes become
// per-credential once more than one slot is registered. Slot ids are safe
// identifiers only — no credential value ever enters this state (NFM-5743
// hygiene; NFM-5768 AC4).

/** The incumbent credential slot (the only slot until slot B registers). */
export const CANARY_DEFAULT_SLOT_ID = "A";

/** Consecutive failures before a slot's episode opens (NFM-5747: ≥2 → page). */
export const CANARY_RED_THRESHOLD = 2;

export const CANARY_FLEET_STATE_SCHEMA_VERSION = 1;

export type CanarySlotId = string;

/** One credential slot's liveness state — the R1 counters, per slot. */
export type CanarySlotState = {
  slotId: CanarySlotId;
  consecutiveFailures: number;
  /** The slot's red episode is open (≥ threshold consecutive failures). */
  episodeOpen: boolean;
  /** When the open episode first went red; null while no episode is open. */
  firstRedAt: string | null;
};

/** The state-file shape: per-slot counters behind a versioned envelope. */
export type CanaryFleetState = {
  schemaVersion: typeof CANARY_FLEET_STATE_SCHEMA_VERSION;
  slots: Record<CanarySlotId, CanarySlotState>;
};

/** Rarer, louder alarm class for "every registered slot is red". */
export type CanaryFleetAlarmClass = "healthy" | "slot_red" | "fleet_emergency";

export type CanaryProbeObservation = {
  slotId: CanarySlotId;
  ok: boolean;
  at: string;
};

export function emptyCanaryFleetState(): CanaryFleetState {
  return {
    schemaVersion: CANARY_FLEET_STATE_SCHEMA_VERSION,
    slots: {},
  };
}

function requireSlotId(slotId: CanarySlotId): CanarySlotId {
  const trimmed = slotId.trim();
  if (trimmed.length === 0) {
    throw new Error("canary slot id must be a non-empty identifier");
  }
  return trimmed;
}

function slotState(
  state: CanaryFleetState,
  slotId: CanarySlotId,
): CanarySlotState {
  return (
    state.slots[slotId] ?? {
      slotId,
      consecutiveFailures: 0,
      episodeOpen: false,
      firstRedAt: null,
    }
  );
}

/**
 * Records one probe outcome. Green closes that slot's episode and resets its
 * count; a failure increments it, opening the slot's episode at the threshold
 * (first-red timestamp = the threshold-crossing probe). Slots are independent
 * — this is what makes episodes per-credential. Pure: returns a new state.
 */
export function applyCanaryProbe(
  state: CanaryFleetState,
  observation: CanaryProbeObservation,
): CanaryFleetState {
  const slotId = requireSlotId(observation.slotId);
  const current = slotState(state, slotId);
  const next: CanarySlotState = observation.ok
    ? {
        slotId,
        consecutiveFailures: 0,
        episodeOpen: false,
        firstRedAt: null,
      }
    : {
        slotId,
        consecutiveFailures: current.consecutiveFailures + 1,
        episodeOpen:
          current.episodeOpen || current.consecutiveFailures + 1 >= CANARY_RED_THRESHOLD,
        firstRedAt: current.firstRedAt ?? (current.consecutiveFailures + 1 >= CANARY_RED_THRESHOLD ? observation.at : null),
      };
  return {
    ...state,
    slots: { ...state.slots, [slotId]: next },
  };
}

/** A slot is red while its episode is open (≥ threshold consecutive fails). */
export function isSlotRed(state: CanaryFleetState, slotId: CanarySlotId): boolean {
  return state.slots[slotId]?.episodeOpen === true;
}

/** Red slots, optionally narrowed to (and ordered by) the registered ids. */
export function redSlots(state: CanaryFleetState, registeredSlotIds?: CanarySlotId[]): CanarySlotId[] {
  const ids = registeredSlotIds ?? Object.keys(state.slots);
  return ids.filter((slotId) => isSlotRed(state, slotId));
}

/**
 * The alarm class for the heartbeat lane:
 * - `healthy` — no registered slot is red;
 * - `slot_red` — at least one registered slot is red (the existing, ordinary
 *   `[SRE-CRITICAL]` class; with N=1 this is exactly today's alarm);
 * - `fleet_emergency` — N≥2 and EVERY registered slot is red: the rarer,
 *   louder "whole fleet lost its upstream" signal.
 * A single registered slot deliberately cannot produce `fleet_emergency` —
 * that keeps single-slot (slot-A-only) operation byte-identical to today.
 */
export function classifyCanaryFleet(
  state: CanaryFleetState,
  registeredSlotIds: CanarySlotId[],
): CanaryFleetAlarmClass {
  const registered = [...new Set(registeredSlotIds.map((slotId) => slotId.trim()))]
    .filter((slotId) => slotId.length > 0);
  if (registered.length === 0) return "healthy";
  const redCount = registered.filter((slotId) => isSlotRed(state, slotId)).length;
  if (redCount === 0) return "healthy";
  if (registered.length >= 2 && redCount === registered.length) return "fleet_emergency";
  return "slot_red";
}

export type LegacyCanaryState = {
  /** R1's single consecutive-failure counter. */
  consecutiveFailures: number;
  episodeOpen?: boolean;
  firstRedAt?: string | null;
};

export type MigrateLegacyCanaryStateOptions = {
  /**
   * Migration timestamp, stamped onto an open episode whose legacy file
   * carried no first-red time — the true first-red is at or before it.
   */
  at: string;
  slotId?: CanarySlotId;
};

/**
 * Maps the R1 (NFM-5747) single-slot state file onto the per-slot schema,
 * under the incumbent slot id. Derives a missing episode-open flag from the
 * counter so either R1 file variant migrates cleanly. The result always
 * satisfies the state-file parser's invariants: an open episode without a
 * first-red timestamp is stamped with `options.at` (legacy R1 files never
 * stamped one), and a stale timestamp on a closed episode is dropped.
 */
export function migrateLegacyCanaryState(
  legacy: LegacyCanaryState,
  options: MigrateLegacyCanaryStateOptions,
): CanaryFleetState {
  const id = requireSlotId(options.slotId ?? CANARY_DEFAULT_SLOT_ID);
  const stamp = parseIsoTimestamp(options.at, "migration at");
  const failures = Math.max(0, Math.floor(legacy.consecutiveFailures));
  const episodeOpen = legacy.episodeOpen ?? failures >= CANARY_RED_THRESHOLD;
  return {
    schemaVersion: CANARY_FLEET_STATE_SCHEMA_VERSION,
    slots: {
      [id]: {
        slotId: id,
        consecutiveFailures: failures,
        episodeOpen,
        firstRedAt: episodeOpen ? legacy.firstRedAt ?? stamp : null,
      },
    },
  };
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`canary state ${label} must be an object`);
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`canary state ${label} has unexpected key "${key}"`);
    }
  }
}

function parseIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`canary state ${label} must be an ISO timestamp`);
  }
  return value;
}

function parseSlotState(slotId: string, value: unknown): CanarySlotState {
  const record = asRecord(value, `slot "${slotId}"`);
  // Closed allowlist: no credential material can ever ride in a slot entry.
  exactKeys(record, ["slotId", "consecutiveFailures", "episodeOpen", "firstRedAt"], `slot "${slotId}"`);
  const statedId = record.slotId;
  if (typeof statedId !== "string" || statedId.trim().length === 0 || statedId !== slotId) {
    throw new Error(`canary state slot "${slotId}" has a mismatched slotId`);
  }
  const consecutiveFailures = record.consecutiveFailures;
  if (
    typeof consecutiveFailures !== "number" ||
    !Number.isInteger(consecutiveFailures) ||
    consecutiveFailures < 0
  ) {
    throw new Error(`canary state slot "${slotId}" consecutiveFailures must be a non-negative integer`);
  }
  const episodeOpen = record.episodeOpen;
  if (typeof episodeOpen !== "boolean") {
    throw new Error(`canary state slot "${slotId}" episodeOpen must be a boolean`);
  }
  const rawFirstRedAt = record.firstRedAt;
  if (rawFirstRedAt !== null && typeof rawFirstRedAt !== "string") {
    throw new Error(`canary state slot "${slotId}" firstRedAt must be null or an ISO timestamp`);
  }
  const firstRedAt = rawFirstRedAt === null ? null : parseIsoTimestamp(rawFirstRedAt, `slot "${slotId}" firstRedAt`);
  // Invariants an episode cannot legitimately violate.
  if (episodeOpen && firstRedAt === null) {
    throw new Error(`canary state slot "${slotId}" has an open episode without a first-red timestamp`);
  }
  if (!episodeOpen && firstRedAt !== null) {
    throw new Error(`canary state slot "${slotId}" has a first-red timestamp but no open episode`);
  }
  if (episodeOpen && consecutiveFailures < CANARY_RED_THRESHOLD) {
    throw new Error(`canary state slot "${slotId}" has an open episode below the red threshold`);
  }
  return {
    slotId,
    consecutiveFailures,
    episodeOpen,
    firstRedAt,
  };
}

/**
 * Parses (and validates) the JSON state file the canary lane persists.
 * Accepts the serialized JSON text or an already-parsed object. Throws on
 * any shape drift — including unknown keys, so credential-looking fields
 * can never be smuggled into state.
 */
export function parseCanaryFleetState(raw: unknown): CanaryFleetState {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const record = asRecord(parsed, "document");
  exactKeys(record, ["schemaVersion", "slots"], "document");
  if (record.schemaVersion !== CANARY_FLEET_STATE_SCHEMA_VERSION) {
    throw new Error(`canary state schemaVersion must be ${CANARY_FLEET_STATE_SCHEMA_VERSION}`);
  }
  const slots: Record<CanarySlotId, CanarySlotState> = {};
  if (record.slots !== undefined) {
    const slotsRecord = asRecord(record.slots, "slots");
    for (const [slotId, value] of Object.entries(slotsRecord)) {
      const state = parseSlotState(slotId, value);
      slots[slotId] = state;
    }
  }
  return { schemaVersion: CANARY_FLEET_STATE_SCHEMA_VERSION, slots };
}

/** Deterministic serialization (sorted slot ids) for readable state diffs. */
export function serializeCanaryFleetState(state: CanaryFleetState): string {
  const slots: Record<CanarySlotId, CanarySlotState> = {};
  for (const slotId of Object.keys(state.slots).sort()) {
    slots[slotId] = state.slots[slotId];
  }
  return JSON.stringify({ schemaVersion: state.schemaVersion, slots }, null, 2);
}

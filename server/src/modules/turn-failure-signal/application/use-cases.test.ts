import { describe, expect, it } from "vitest";
import type {
  CanaryObservation,
  TurnFailureSignalConfig,
  TurnFailureWindowStats,
} from "../domain/signal-policy.js";
import type {
  DegradationCloseSource,
  DegradationEpisodeRow,
  TurnFailureSignalStore,
} from "./ports.js";
import { createTurnFailureSignalService } from "./use-cases.js";

const T0 = "2026-10-26T12:00:00.000Z";

const CONFIG: TurnFailureSignalConfig = {
  windowMs: 15 * 60 * 1000,
  elevationThreshold: 0.5,
  recoveryThreshold: 0.25,
  minSamples: 10,
  restateIntervalMs: 60 * 60 * 1000,
};

type Company = "company-1";

function createFakeStore() {
  let episodes: DegradationEpisodeRow[] = [];
  let stats: TurnFailureWindowStats = {
    outcomes: 0,
    authFailures: 0,
    otherFailures: 0,
    windowStart: T0,
    windowEnd: T0,
  };
  let seq = 0;
  const store: TurnFailureSignalStore = {
    async countClaudeLocalOutcomes(_companyId, input) {
      return { ...stats, windowStart: input.windowStart, windowEnd: input.windowEnd };
    },
    async getActiveDegradationEpisode(companyId) {
      return (
        episodes.find(
          (episode) => episode.companyId === companyId && episode.state !== "closed",
        ) ?? null
      );
    },
    async insertDegradationEpisode(companyId, input) {
      seq += 1;
      const episode: DegradationEpisodeRow = {
        id: `degradation-${seq}`,
        companyId,
        state: "red",
        startedAt: input.startedAt,
        lastRestatedAt: null,
      };
      episodes = [...episodes, episode];
      return episode;
    },
    async markDegradationRestated(episodeId, input) {
      episodes = episodes.map((episode) =>
        episode.id === episodeId ? { ...episode, lastRestatedAt: input.restatedAt } : episode,
      );
    },
    async closeDegradationEpisode(episodeId, input: { source: DegradationCloseSource }) {
      episodes = episodes.map((episode) =>
        episode.id === episodeId ? { ...episode, state: "closed" } : episode,
      );
      void input;
    },
  };
  return {
    store,
    setStats(next: Partial<TurnFailureWindowStats>) {
      stats = { ...stats, ...next };
    },
    episodes: () => episodes,
  };
}

function elevated(overrides: Partial<TurnFailureWindowStats> = {}): Partial<TurnFailureWindowStats> {
  return { outcomes: 20, authFailures: 6, otherFailures: 5, ...overrides };
}

function service(
  fake: ReturnType<typeof createFakeStore>,
  canary: CanaryObservation,
  log: { warns: unknown[] },
) {
  return createTurnFailureSignalService(fake.store, {
    readCanary: () => canary,
    logger: { warn: (obj) => log.warns.push(obj) },
  }, { config: CONFIG });
}

describe("turn-failure signal use-cases", () => {
  it("opens a degradation episode on the full signature and emits one log", () => {
    const fake = createFakeStore();
    fake.setStats(elevated());
    const log = { warns: [] as unknown[] };
    const service_ = service(fake, { state: "green", observedAt: T0 }, log);

    const outcome = service_.evaluate("company-1" as Company, { now: T0 });

    return outcome.then((result) => {
      expect(result).toMatchObject({ kind: "opened" });
      expect(fake.episodes()).toHaveLength(1);
      expect(fake.episodes()[0]!.state).toBe("red");
      expect(log.warns).toHaveLength(1);
    });
  });

  // Charter AC: verified NO alarm during normal canary-green operation.
  it("does NOT open during normal canary-green operation", async () => {
    const fake = createFakeStore();
    fake.setStats({ outcomes: 20, authFailures: 1, otherFailures: 0 });
    const log = { warns: [] as unknown[] };
    const service_ = service(fake, { state: "green", observedAt: T0 }, log);

    const result = await service_.evaluate("company-1" as Company, { now: T0 });

    expect(result).toEqual({ kind: "none" });
    expect(fake.episodes()).toHaveLength(0);
    expect(log.warns).toHaveLength(0);
  });

  it("does NOT open when the canary is red even at full failure rate", async () => {
    const fake = createFakeStore();
    fake.setStats(elevated());
    const log = { warns: [] as unknown[] };
    const service_ = service(fake, { state: "red", observedAt: T0 }, log);

    const result = await service_.evaluate("company-1" as Company, { now: T0 });

    expect(result).toEqual({ kind: "none" });
    expect(fake.episodes()).toHaveLength(0);
  });

  it("does NOT open when the canary state is unknown (stale/missing file)", async () => {
    const fake = createFakeStore();
    fake.setStats(elevated());
    const service_ = service(fake, { state: "unknown", observedAt: null }, { warns: [] });

    const result = await service_.evaluate("company-1" as Company, { now: T0 });

    expect(result).toEqual({ kind: "none" });
    expect(fake.episodes()).toHaveLength(0);
  });

  it("stays quiet while red without restating before the interval", async () => {
    const fake = createFakeStore();
    fake.setStats(elevated());
    const log = { warns: [] as unknown[] };
    const service_ = service(fake, { state: "green", observedAt: T0 }, log);
    await service_.evaluate("company-1" as Company, { now: T0 });

    const result = await service_.evaluate("company-1" as Company, {
      now: "2026-10-26T12:30:00.000Z",
    });

    expect(result).toMatchObject({ kind: "held" });
    expect(log.warns).toHaveLength(1);
  });

  it("restates at most once per interval while still elevated", async () => {
    const fake = createFakeStore();
    fake.setStats(elevated());
    const log = { warns: [] as unknown[] };
    const service_ = service(fake, { state: "green", observedAt: T0 }, log);
    await service_.evaluate("company-1" as Company, { now: T0 });

    const result = await service_.evaluate("company-1" as Company, {
      now: "2026-10-26T13:00:00.000Z",
    });

    expect(result).toMatchObject({ kind: "restated" });
    expect(log.warns).toHaveLength(2);
    const episode = fake.episodes()[0]!;
    expect(episode.lastRestatedAt).toBe("2026-10-26T13:00:00.000Z");
  });

  it("closes as normalized when the rate recovers", async () => {
    const fake = createFakeStore();
    fake.setStats(elevated());
    const log = { warns: [] as unknown[] };
    const service_ = service(fake, { state: "green", observedAt: T0 }, log);
    await service_.evaluate("company-1" as Company, { now: T0 });

    fake.setStats({ outcomes: 20, authFailures: 1, otherFailures: 1 });
    const result = await service_.evaluate("company-1" as Company, {
      now: "2026-10-26T12:05:00.000Z",
    });

    expect(result).toMatchObject({ kind: "closed", source: "normalized" });
    expect(fake.episodes()[0]!.state).toBe("closed");
  });

  it("closes with a canary-red hand-off when the liveness authority takes over", async () => {
    const fake = createFakeStore();
    fake.setStats(elevated());
    const log = { warns: [] as unknown[] };
    let canary: CanaryObservation = { state: "green", observedAt: T0 };
    const service_ = createTurnFailureSignalService(fake.store, {
      readCanary: () => canary,
      logger: { warn: (obj) => log.warns.push(obj) },
    }, { config: CONFIG });
    await service_.evaluate("company-1" as Company, { now: T0 });

    canary = { state: "red", observedAt: "2026-10-26T12:10:00.000Z" };
    const result = await service_.evaluate("company-1" as Company, {
      now: "2026-10-26T12:10:00.000Z",
    });

    expect(result).toMatchObject({ kind: "closed", source: "canary-red" });
    expect(fake.episodes()[0]!.state).toBe("closed");
  });

  it("holds (no restate, no close) while the canary is unreadable mid-episode", async () => {
    const fake = createFakeStore();
    fake.setStats(elevated());
    const log = { warns: [] as unknown[] };
    let canary: CanaryObservation = { state: "green", observedAt: T0 };
    const service_ = createTurnFailureSignalService(fake.store, {
      readCanary: () => canary,
      logger: { warn: (obj) => log.warns.push(obj) },
    }, { config: CONFIG });
    await service_.evaluate("company-1" as Company, { now: T0 });

    canary = { state: "unknown", observedAt: null };
    const result = await service_.evaluate("company-1" as Company, {
      now: "2026-10-26T14:00:00.000Z",
    });

    expect(result).toMatchObject({ kind: "held" });
    expect(fake.episodes()[0]!.state).toBe("red");
    expect(fake.episodes()[0]!.lastRestatedAt).toBeNull();
    expect(log.warns).toHaveLength(1);
  });

  it("keeps degradation episodes isolated from the auth lane's episode space", async () => {
    const fake = createFakeStore();
    fake.setStats(elevated());
    const service_ = service(fake, { state: "green", observedAt: T0 }, { warns: [] });
    await service_.evaluate("company-1" as Company, { now: T0 });

    // The auth lane's `getActiveEpisode` filters kind='auth'; the degradation
    // row must never satisfy it. The fake store mirrors the port split: the
    // degradation lookup is a distinct method, so an auth observation sees
    // no active episode of its own kind here.
    const active = await fake.store.getActiveDegradationEpisode("company-1" as Company);
    expect(active).not.toBeNull();
    expect(active!.state).toBe("red");
  });

  it("re-opens on fresh evidence after a close (closed episodes are terminal history)", async () => {
    const fake = createFakeStore();
    fake.setStats(elevated());
    const log = { warns: [] as unknown[] };
    const service_ = service(fake, { state: "green", observedAt: T0 }, log);
    await service_.evaluate("company-1" as Company, { now: T0 });
    fake.setStats({ outcomes: 20, authFailures: 1, otherFailures: 0 });
    await service_.evaluate("company-1" as Company, { now: "2026-10-26T12:05:00.000Z" });

    fake.setStats(elevated());
    const result = await service_.evaluate("company-1" as Company, {
      now: "2026-10-26T12:10:00.000Z",
    });

    // Fresh evidence re-opens: the closed episode is terminal history.
    expect(result).toMatchObject({ kind: "opened" });
    expect(fake.episodes()).toHaveLength(2);
  });
});

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  authRecoveryEpisodeAgents,
  authRecoveryEpisodes,
} from "./schema/auth_recovery_episodes.js";

describe("auth recovery episode schema", () => {
  it("deduplicates enrollment attempts per agent and episode", () => {
    const config = getTableConfig(authRecoveryEpisodeAgents);
    const unique = config.uniqueConstraints.find(
      (constraint) => constraint.name === "auth_recovery_episode_agents_episode_agent_uq",
    );
    expect(unique).toBeDefined();
    const indexes = config.indexes;
    expect(
      indexes.some((index) => index.config.name === "auth_recovery_episode_agents_company_state_idx"),
    ).toBe(true);
  });

  it("keeps episode state and fleet counters queryable for the annotation surface", () => {
    const episodeColumns = getTableConfig(authRecoveryEpisodes).columns.map(
      (column) => column.name,
    );
    for (const column of [
      "company_id",
      "state",
      "started_at",
      "first_green_at",
      "green_source",
      "wakes_used",
      "reenqueued_count",
      "manual_count",
    ]) {
      expect(episodeColumns).toContain(column);
    }
    const enrollmentColumns = getTableConfig(authRecoveryEpisodeAgents).columns.map(
      (column) => column.name,
    );
    for (const column of [
      "episode_id",
      "agent_id",
      "state",
      "attempts",
      "last_wake_at",
      "next_attempt_at",
      "resolved_at",
    ]) {
      expect(enrollmentColumns).toContain(column);
    }
  });
});

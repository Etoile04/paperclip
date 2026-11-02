import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * NFM-5748 — one `claude_auth_required` episode per company:
 * first auth failure → first green authenticated session → bounded
 * re-enqueue of the still-latched agents (≤3 attempts, 10 min apart,
 * 20 wakes per episode). `red` records latch evidence only; `recovering`
 * means a green observation triggered the re-enqueue; `closed` is terminal.
 */
export const authRecoveryEpisodes = pgTable(
  "auth_recovery_episodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    state: text("state").notNull().default("red"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    firstGreenAt: timestamp("first_green_at", { withTimezone: true }),
    firstGreenRunId: uuid("first_green_run_id"),
    greenSource: text("green_source"),
    // NFM-5775 (ADR-026 §6): credential slot id (never a value) that
    // produced the green, when the observer knows it. Keeps the R4 slot
    // attribution stable across retry sweeps.
    greenSlotId: text("green_slot_id"),
    wakesUsed: integer("wakes_used").notNull().default(0),
    reenqueuedCount: integer("reenqueued_count").notNull().default(0),
    manualCount: integer("manual_count").notNull().default(0),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStateIdx: index("auth_recovery_episodes_company_state_idx").on(
      table.companyId,
      table.state,
    ),
    companyStartedIdx: index("auth_recovery_episodes_company_started_idx").on(
      table.companyId,
      table.startedAt,
    ),
  }),
);

/**
 * Per-agent enrollment inside an episode. Attempts are claimed
 * compare-and-swap style (UPDATE ... WHERE attempts = expected), so two
 * concurrent greens or sweeps can never double-wake one agent.
 */
export const authRecoveryEpisodeAgents = pgTable(
  "auth_recovery_episode_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    episodeId: uuid("episode_id")
      .notNull()
      .references(() => authRecoveryEpisodes.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("enrolled"),
    attempts: integer("attempts").notNull().default(0),
    firstLatchedAt: timestamp("first_latched_at", { withTimezone: true }).notNull(),
    firstLatchedRunId: uuid("first_latched_run_id"),
    lastWakeAt: timestamp("last_wake_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    episodeAgentUq: unique("auth_recovery_episode_agents_episode_agent_uq").on(
      table.episodeId,
      table.agentId,
    ),
    companyStateIdx: index("auth_recovery_episode_agents_company_state_idx").on(
      table.companyId,
      table.state,
    ),
    episodeStateIdx: index("auth_recovery_episode_agents_episode_state_idx").on(
      table.episodeId,
      table.state,
    ),
  }),
);

import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

/**
 * `plugin_config` table — stores operator-provided configuration for each
 * plugin within a company (one row per plugin/company pair).
 *
 * The `config_json` column holds the values that the operator enters in the
 * plugin settings UI. These values are validated at runtime against the
 * plugin's `instanceConfigSchema` from the manifest.
 *
 * Hotfix 2026-09-07: the database already carries `company_id` (added by the
 * 0.83x upgrade lineage); the prod-branch drizzle schema now reflects it so
 * `listConfigs` can resolve per-company proactive scopes (LOOA-695 backport).
 *
 * @see PLUGIN_SPEC.md §21.3
 */
export const pluginConfig = pgTable(
  "plugin_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginIdIdx: uniqueIndex("plugin_config_plugin_id_idx").on(table.pluginId),
  }),
);

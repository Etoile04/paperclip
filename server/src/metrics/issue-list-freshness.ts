/**
 * Issues-list freshness canary metrics (NFM-5843, AC2).
 *
 * The in-server canary (see `services/issue-list-freshness-canary.ts`) writes
 * a sentinel row every tick and reads it back through the production list
 * query shape. Two counters expose its health on the Prometheus scrape
 * surface:
 *
 * - `paperclip_issue_list_freshness_tick_total{outcome}` — one increment per
 *   canary tick. `outcome` is `fresh` (read-back saw the write same-tick) or
 *   `lagging` (the write was not yet visible through the list query).
 *
 * - `paperclip_issue_list_freshness_visibility_lag_breaches_total` —
 *   incremented once per stuck sentinel write whose visibility lag first
 *   exceeds the 10s threshold. This is the alert-worthy series: a non-zero
 *   rate is the recurrence signature of the NFM-5838 frozen-snapshot fault.
 *
 * Both counters live on a dedicated `Registry` (same pattern as
 * `metrics/precompletion.ts`) so tests can build isolated bundles per case
 * and a scrape before the first tick still surfaces pre-created zero series.
 */

import { Counter, Registry } from "prom-client";

const TICK_METRIC_NAME = "paperclip_issue_list_freshness_tick_total";
const BREACH_METRIC_NAME =
  "paperclip_issue_list_freshness_visibility_lag_breaches_total";

const TICK_OUTCOMES = ["fresh", "lagging"] as const;

export type IssueListFreshnessTickOutcome = (typeof TICK_OUTCOMES)[number];

export type IssueListFreshnessMetrics = {
  tick(outcome: IssueListFreshnessTickOutcome): void;
  breach(): void;
  snapshot(): Promise<{
    ticksFresh: number;
    ticksLagging: number;
    breaches: number;
  }>;
  render(): Promise<string>;
};

export function createIssueListFreshnessMetrics(
  registry: Registry = new Registry(),
): IssueListFreshnessMetrics {
  const ticks = new Counter({
    name: TICK_METRIC_NAME,
    help: "Issues-list freshness canary ticks by outcome (fresh: sentinel visible same-tick; lagging: write not yet visible through the list query).",
    labelNames: ["outcome"],
    registers: [registry],
  });
  const breaches = new Counter({
    name: BREACH_METRIC_NAME,
    help: "Canary sentinel writes whose visibility lag through the issues-list query shape first exceeded the 10s threshold (NFM-5838 recurrence signature).",
    registers: [registry],
  });

  // Pre-create the label series at zero so a scrape before the first event
  // still surfaces the series with stable labels.
  for (const outcome of TICK_OUTCOMES) ticks.inc({ outcome });

  // Event counts since bundle creation (excluding the pre-created zero
  // samples) — what tests and the canary assert on.
  let freshCount = 0;
  let laggingCount = 0;
  let breachCount = 0;

  return {
    tick(outcome) {
      if (outcome === "fresh") freshCount += 1;
      else laggingCount += 1;
      ticks.inc({ outcome });
    },
    breach() {
      breachCount += 1;
      breaches.inc();
    },
    async snapshot() {
      return {
        ticksFresh: freshCount,
        ticksLagging: laggingCount,
        breaches: breachCount,
      };
    },
    render() {
      return registry.metrics();
    },
  };
}

let singleton: IssueListFreshnessMetrics | null = null;

/** Process-wide bundle used by the runtime canary (lazy-initialized). */
export function getIssueListFreshnessMetrics(): IssueListFreshnessMetrics {
  if (!singleton) singleton = createIssueListFreshnessMetrics();
  return singleton;
}

/** Prometheus text exposition for the metrics scrape route. */
export async function renderIssueListFreshnessMetrics(): Promise<string> {
  return getIssueListFreshnessMetrics().render();
}

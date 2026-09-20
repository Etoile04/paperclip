/**
 * Interaction read-path fallback counter (NFM-4974/NFM-4978 D2, NFM-5017).
 *
 * Out-of-band expiry writers once stored `result` payloads outside the shared
 * result schemas (e.g. `outcome: "auto_expired_healer_…"`), which made
 * `hydrateInteraction` throw and permanently 400 `GET /api/issues/:id/interactions`.
 * The read path now tolerates malformed results — expired rows get a read-time
 * fallback result, non-expired rows serve `result: null` with a warn log.
 *
 * This counter records every such fallback, labeled by interaction `kind`, so a
 * D3 backfill can verify convergence (rate → 0) and future out-of-band writers
 * are caught by a non-zero rate after deploy.
 *
 * Implementation: prom-client Counter on a dedicated Registry with a closed
 * label set (bounded cardinality), shared process-wide bundle, fresh-registry
 * factory for tests, snapshot + Prometheus render helpers. Label series are
 * pre-created at zero so a scrape before the first fallback still surfaces
 * the series. The scrape surface lives at `GET /api/metrics` (see
 * `routes/metrics.ts`).
 */

import { Counter, Registry } from "prom-client";
import type { IssueThreadInteractionKind } from "@paperclipai/shared";

const FALLBACK_METRIC_NAME = "paperclip_interaction_result_fallback_total";

const FALLBACK_METRIC_HELP =
  "Total issue thread interactions whose stored result failed schema validation and were served via the read-time fallback (expired rows) or as result:null (non-expired rows), labeled by interaction kind.";

/** Closed label set: one series per interaction kind. */
const FALLBACK_KINDS: readonly IssueThreadInteractionKind[] = [
  "suggest_tasks",
  "ask_user_questions",
  "request_confirmation",
  "request_checkbox_confirmation",
];

export interface InteractionResultFallbackMetrics {
  readonly registry: Registry;
  readonly fallback: Counter<"kind">;
}

/**
 * Build a fresh fallback-metrics bundle on a private registry. Public so tests
 * can construct isolated counters per case (same contract as
 * `createPrecompletionMetrics`).
 */
export function createInteractionResultFallbackMetrics(
  registry: Registry = new Registry(),
): InteractionResultFallbackMetrics {
  const fallback = new Counter({
    name: FALLBACK_METRIC_NAME,
    help: FALLBACK_METRIC_HELP,
    labelNames: ["kind"],
    registers: [registry],
  });

  // Pre-create the label series at zero so a Prometheus scrape before the
  // first fallback still surfaces the metric with stable labels.
  for (const kind of FALLBACK_KINDS) {
    fallback.inc({ kind }, 0);
  }

  return { registry, fallback };
}

let shared: InteractionResultFallbackMetrics | null = null;

/**
 * Lazily-constructed process-wide bundle. First call wins; later calls return
 * the same instance. Test isolation requires
 * {@link __resetInteractionResultFallbackMetricsForTests} or a fresh
 * {@link createInteractionResultFallbackMetrics} registry.
 */
export function getInteractionResultFallbackMetrics(): InteractionResultFallbackMetrics {
  if (!shared) {
    shared = createInteractionResultFallbackMetrics();
  }
  return shared;
}

/**
 * Reset the process-wide bundle. Test-only — production code should never call
 * this.
 */
export function __resetInteractionResultFallbackMetricsForTests(): void {
  shared = null;
}

export function recordInteractionResultFallback(
  kind: IssueThreadInteractionKind,
  metrics: InteractionResultFallbackMetrics = getInteractionResultFallbackMetrics(),
): void {
  metrics.fallback.inc({ kind });
}

/** Flat snapshot for assertions. Exposed primarily for tests and diagnostics. */
export async function snapshotInteractionResultFallbackMetrics(
  metrics: InteractionResultFallbackMetrics = getInteractionResultFallbackMetrics(),
): Promise<Record<string, number>> {
  const samples = await metrics.fallback.get();
  const out: Record<string, number> = {};
  for (const sample of samples.values) {
    out[sample.labels.kind ?? ""] = sample.value;
  }
  return out;
}

/**
 * Render in Prometheus text exposition format. Suitable for merging into the
 * standard scrape surface alongside the precompletion metrics.
 */
export async function renderInteractionResultFallbackMetrics(
  metrics: InteractionResultFallbackMetrics = getInteractionResultFallbackMetrics(),
): Promise<string> {
  return metrics.registry.metrics();
}

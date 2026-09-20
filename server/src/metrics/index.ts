/**
 * Barrel export for the server-side metrics modules.
 *
 * Two Counter bundles ship today:
 *
 * - `precompletion` — NFM-3859 PreCompletionMerge hook rejection + bypass
 *   counters. Incremented from the API middleware + ADK runtime hook on
 *   terminal `done` PATCH transitions.
 *
 * - `interaction-result-fallback` — NFM-4974/NFM-5017 read-time fallback
 *   counter. Incremented from `services/issue-thread-interactions.ts` whenever
 *   a stored `issue_thread_interactions.result` row fails schema validation
 *   and the read path substitutes an `auto_expired` fallback or returns
 *   `result: null` with a warn log.
 *
 * Both bundles are scraped via `routes/metrics.ts` (`GET /api/metrics`), which
 * renders their dedicated Registries in Prometheus text exposition format.
 * Future metrics (rate-limit rejections, ADK retry counters, etc.) should be
 * added here AND wired into `routes/metrics.ts` so the scrape surface stays
 * the single import path.
 */

export {
  PrecompletionBypassActorKind,
  PrecompletionRejectionReason,
  __resetPrecompletionMetricsForTests,
  createPrecompletionMetrics,
  getPrecompletionMetrics,
  recordPrecompletionBypass,
  recordPrecompletionRejection,
  renderPrecompletionMetrics,
  snapshotPrecompletionMetrics,
} from "./precompletion.js";
export type {
  PrecompletionBypassActorKind as PrecompletionBypassActorKindType,
  PrecompletionMetrics,
  PrecompletionRejectionReason as PrecompletionRejectionReasonType,
  PrecompletionSnapshot,
} from "./precompletion.js";

export {
  __resetInteractionResultFallbackMetricsForTests,
  createInteractionResultFallbackMetrics,
  getInteractionResultFallbackMetrics,
  recordInteractionResultFallback,
  renderInteractionResultFallbackMetrics,
  snapshotInteractionResultFallbackMetrics,
} from "./interaction-result-fallback.js";
export type { InteractionResultFallbackMetrics } from "./interaction-result-fallback.js";
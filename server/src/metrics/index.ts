/**
 * Barrel export for the server-side metrics modules.
 *
 * Currently only PreCompletionMerge hook metrics (NFM-3859) are exported.
 * Future metrics (rate-limit rejections, ADK retry counters, etc.) should
 * be added here so the API middleware and adapter hooks have a single
 * import surface.
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
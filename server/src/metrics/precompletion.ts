/**
 * PreCompletionMerge hook metrics.
 *
 * Counters track two outcomes of the `PreCompletionMerge` hook that gates
 * terminal `done` PATCH transitions on `merge-kind` issues (see NFM-3855 /
 * NFM-3853 / NFM-3850 for the design doc):
 *
 * - `paperclip_precompletion_merge_rejected_total{reason}` — incremented
 *   every time the hook returns a 422 to a terminal `done` PATCH. `reason`
 *   labels are stable enum strings (see {@link PrecompletionRejectionReason})
 *   so dashboards can slice on them without high-cardinality risk.
 *
 * - `paperclip_precompletion_bypass_total{actor_kind}` — incremented every
 *   time the hook lets a terminal `done` PATCH through despite the issue
 *   being `merge-kind` (i.e. the actor is a trusted system identity that the
 *   hook is configured to bypass). `actor_kind` is also a stable enum.
 *
 * Both counters live on a dedicated `Registry` so they can be exported
 * separately from the application's default Prometheus registry, and so the
 * integration tests can build a fresh registry per case without leaking
 * state between runs.
 *
 * The hook itself lives in the API middleware (see NFM-3857) and the ADK
 * runtime hook (see NFM-3858). They call {@link recordPrecompletionRejection}
 * and {@link recordPrecompletionBypass} from their terminal-PATCH handlers.
 *
 * @see docs/precompletion-metrics-dashboard.md for the suggested Grafana panels.
 */

import { Counter, Registry } from "prom-client";

/**
 * Stable rejection reason labels for `paperclip_precompletion_merge_rejected_total`.
 *
 * Keep this enum closed and additive. New reasons are allowed; renames or
 * removals break dashboards. The strings here MUST match what the hook
 * middleware (NFM-3857) writes into the structured 422 error response.
 */
export const PrecompletionRejectionReason = {
  /** Branch extracted from title does not appear as an ancestor of origin/main. */
  NonAncestorBranch: "non_ancestor_branch",
  /** Title matches the merge-kind pattern but no branch can be extracted. */
  NoExtractableBranch: "no_extractable_branch",
  /** Merge-kind issue but no execution workspace is registered for it. */
  NoExecutionWorkspace: "no_execution_workspace",
} as const;

export type PrecompletionRejectionReason =
  (typeof PrecompletionRejectionReason)[keyof typeof PrecompletionRejectionReason];

/**
 * Stable actor-kind labels for `paperclip_precompletion_bypass_total`.
 *
 * `system` covers the system actor that the hook treats as trusted-by-policy.
 * Other values are reserved for future bypass paths (cron-driven cleanup,
 * recovery ghosts, etc.) and must be added here before the middleware emits
 * them so the label set stays closed.
 */
export const PrecompletionBypassActorKind = {
  System: "system",
} as const;

export type PrecompletionBypassActorKind =
  (typeof PrecompletionBypassActorKind)[keyof typeof PrecompletionBypassActorKind];

const REJECTED_METRIC_NAME = "paperclip_precompletion_merge_rejected_total";
const BYPASS_METRIC_NAME = "paperclip_precompletion_bypass_total";

const REJECTED_METRIC_HELP =
  "Total terminal `done` PATCH transitions rejected by the PreCompletionMerge hook, labeled by structured rejection reason.";
const BYPASS_METRIC_HELP =
  "Total terminal `done` PATCH transitions that bypassed the PreCompletionMerge hook, labeled by trusted actor kind.";

/**
 * Build a fresh precompletion-metrics bundle on a private registry.
 *
 * Public so the test suite can construct isolated counters per case and so
 * the runtime hook can opt into a side-registry when running inside the
 * paperclip fork's main registry (in case downstream tooling merges both).
 *
 * Label cardinality is bounded by the closed {@link PrecompletionRejectionReason}
 * and {@link PrecompletionBypassActorKind} enums — both names use snake_case
 * + `_total` suffix to match the upstream Prometheus convention.
 */
export function createPrecompletionMetrics(registry: Registry = new Registry()): PrecompletionMetrics {
  const rejected = new Counter({
    name: REJECTED_METRIC_NAME,
    help: REJECTED_METRIC_HELP,
    labelNames: ["reason"],
    registers: [registry],
  });

  const bypassed = new Counter({
    name: BYPASS_METRIC_NAME,
    help: BYPASS_METRIC_HELP,
    labelNames: ["actor_kind"],
    registers: [registry],
  });

  // Pre-create the label series with 0 values so a Prometheus scrape before
  // the first event still surfaces the metrics with stable labels. Without
  // this, a fresh process would omit the series entirely and dashboards
  // would silently lose them.
  for (const reason of Object.values(PrecompletionRejectionReason)) {
    rejected.inc({ reason }, 0);
  }
  for (const actorKind of Object.values(PrecompletionBypassActorKind)) {
    bypassed.inc({ actor_kind: actorKind }, 0);
  }

  return {
    registry,
    rejected,
    bypassed,
  };
}

export interface PrecompletionMetrics {
  readonly registry: Registry;
  readonly rejected: Counter<"reason">;
  readonly bypassed: Counter<"actor_kind">;
}

let shared: PrecompletionMetrics | null = null;

/**
 * Lazily-constructed process-wide bundle. The first call wins; later calls
 * return the same instance so test isolation can only be achieved by
 * calling {@link createPrecompletionMetrics} directly with a fresh registry.
 */
export function getPrecompletionMetrics(): PrecompletionMetrics {
  if (!shared) {
    shared = createPrecompletionMetrics();
  }
  return shared;
}

/**
 * Reset the process-wide bundle. Test-only — production code should never
 * need to call this. Kept as a named export (rather than living inside a
 * test fixture) so the lifecycle is documented next to the metric itself.
 */
export function __resetPrecompletionMetricsForTests(): void {
  shared = null;
}

export function recordPrecompletionRejection(
  reason: PrecompletionRejectionReason,
  metrics: PrecompletionMetrics = getPrecompletionMetrics(),
): void {
  metrics.rejected.inc({ reason });
}

export function recordPrecompletionBypass(
  actorKind: PrecompletionBypassActorKind,
  metrics: PrecompletionMetrics = getPrecompletionMetrics(),
): void {
  metrics.bypassed.inc({ actor_kind: actorKind });
}

/**
 * Snapshot the metric values for assertions. Exposed primarily for tests —
 * the production hook should call the `record*` helpers and let Prometheus
 * scrape via {@link renderPrecompletionMetrics}.
 */
export interface PrecompletionSnapshot {
  rejected: Record<string, number>;
  bypassed: Record<string, number>;
}

export async function snapshotPrecompletionMetrics(
  metrics: PrecompletionMetrics = getPrecompletionMetrics(),
): Promise<PrecompletionSnapshot> {
  const rejectedSamples = await metrics.rejected.get();
  const bypassedSamples = await metrics.bypassed.get();

  const flatten = (samples: Awaited<ReturnType<Counter<string>["get"]>>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const sample of samples.values) {
      const labelValue = sample.labels.reason ?? sample.labels.actor_kind ?? "";
      out[labelValue] = sample.value;
    }
    return out;
  };

  return {
    rejected: flatten(rejectedSamples),
    bypassed: flatten(bypassedSamples),
  };
}

/**
 * Render the metrics in Prometheus text exposition format. Suitable for an
 * unauthenticated `/metrics` endpoint that the standard scrape job can hit.
 */
export async function renderPrecompletionMetrics(
  metrics: PrecompletionMetrics = getPrecompletionMetrics(),
): Promise<string> {
  return metrics.registry.metrics();
}
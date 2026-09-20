/**
 * Prometheus scrape surface for server-side metrics.
 *
 * Mounts a tiny read-only endpoint that concatenates every Counter bundle we
 * own onto a single text-exposition response. Concretely:
 *
 *   - `paperclip_precompletion_merge_rejected_total{reason}`
 *   - `paperclip_precompletion_bypass_total{actor_kind}`
 *   - `paperclip_interaction_result_fallback_total{kind}` (NFM-4974/NFM-5017)
 *
 * Each Counter lives on a dedicated Registry (see `metrics/precompletion.ts`
 * and `metrics/interaction-result-fallback.ts`) so we can render them without
 * inheriting unrelated default-metric noise. The route is intentionally
 * unauthenticated and side-effect free — Prometheus scrape jobs hit it on a
 * fixed interval and the response is the same Prometheus text format that
 * `prom-client`'s `Registry.metrics()` produces, so dashboards built on either
 * bundle see the series at the same path.
 *
 * Both bundles pre-create their label series at zero on construction, so a
 * scrape before the first event still surfaces the metric with stable labels.
 *
 * @see NFM-3859 for the precompletion hook metrics.
 * @see NFM-4974 / NFM-5017 for the interaction read-fallback counter.
 */
import { Router, type Request, type Response } from "express";
import { logger } from "../middleware/logger.js";
import {
  getInteractionResultFallbackMetrics,
  renderInteractionResultFallbackMetrics,
} from "../metrics/interaction-result-fallback.js";
import {
  getPrecompletionMetrics,
  renderPrecompletionMetrics,
} from "../metrics/precompletion.js";

const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

async function renderAllMetrics(): Promise<string> {
  // Force lazy initialization of both bundles so a fresh process surfaces the
  // pre-created zero label series on the very first scrape. Without this, the
  // shared singletons stay uninitialized until the first `record*` call and a
  // scrape issued before any event would return an empty body.
  getPrecompletionMetrics();
  getInteractionResultFallbackMetrics();

  const [precompletion, fallback] = await Promise.all([
    renderPrecompletionMetrics(),
    renderInteractionResultFallbackMetrics(),
  ]);

  // Each Registry.metrics() call already emits the full Prometheus text
  // envelope (HELP + TYPE + samples). Joining with a blank line keeps
  // prom-client's per-registry preamble intact while still producing a body
  // that scrapers parse as one document.
  return [precompletion, fallback].filter((chunk) => chunk.length > 0).join("\n");
}

export function metricsRoutes(): Router {
  const router = Router();

  router.get("/", async (_req: Request, res: Response) => {
    try {
      const body = await renderAllMetrics();
      res.status(200).set("Content-Type", PROMETHEUS_CONTENT_TYPE).send(body);
    } catch (err) {
      logger.error({ err }, "Failed to render /api/metrics scrape surface");
      // Surface 503 rather than serving a half-rendered body — Prometheus
      // treats a 5xx as a failed scrape and the next interval will retry.
      res.status(503).json({ error: "metrics_render_failed" });
    }
  });

  return router;
}
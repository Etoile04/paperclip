/**
 * NFM-5017 — `/api/metrics` scrape surface.
 *
 * Wire-up regression for the NFM-4974 audit follow-up: `renderInteractionResultFallbackMetrics`
 * is defined but was never invoked from any HTTP handler, so the counter
 * incremented on every fallback but was invisible to monitoring.
 *
 * These tests pin the scrape contract:
 *
 *   - `GET /api/metrics` returns 200 with `text/plain; version=0.0.4` and a
 *     body that contains `paperclip_interaction_result_fallback_total` for
 *     every closed label set member (suggest_tasks, ask_user_questions,
 *     request_confirmation, request_checkbox_confirmation), pre-created at 0.
 *   - The same response includes the precompletion counters so the scrape
 *     surface stays a single import path for operators.
 *   - Incrementing the fallback counter through `recordInteractionResultFallback`
 *     surfaces the new value on the very next scrape (no caching layer).
 *   - Render failures respond 503 so Prometheus treats the scrape as failed
 *     rather than parsing a partial body.
 *
 * The route uses `createInteractionResultFallbackMetrics`-style fresh
 * registries by way of the test-only `__resetInteractionResultFallbackMetricsForTests`
 * hook, mirroring the pattern in `precompletion-metrics.test.ts`.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { errorHandler } from "../middleware/index.js";
import { metricsRoutes } from "../routes/metrics.js";
import {
  __resetInteractionResultFallbackMetricsForTests,
  recordInteractionResultFallback,
} from "../metrics/interaction-result-fallback.js";

function buildApp(): express.Express {
  // Mirror `app.ts`: `app.use("/api", api)` + `api.use("/metrics", metricsRoutes())`.
  // The inner router's `router.get("/", ...)` resolves to the full
  // `/api/metrics` URL only when mounted under the `/metrics` prefix.
  const api = express.Router();
  api.use("/metrics", metricsRoutes());
  const app = express();
  app.use("/api", api);
  app.use(errorHandler);
  return app;
}

describe("/api/metrics — Prometheus scrape surface (NFM-5017)", () => {
  beforeEach(() => {
    __resetInteractionResultFallbackMetricsForTests();
  });

  afterEach(() => {
    __resetInteractionResultFallbackMetricsForTests();
    vi.restoreAllMocks();
  });

  it("returns 200 with Prometheus text-exposition content-type and the fallback metric for every kind", async () => {
    const response = await request(buildApp()).get("/api/metrics");

    expect(response.status).toBe(200);
    // Express may re-order `charset` vs `version` in the canonicalized header
    // value, so match on the three required fragments rather than a strict
    // position-pinned regex.
    const contentType = response.headers["content-type"] ?? "";
    expect(contentType).toMatch(/^text\/plain;/);
    expect(contentType).toContain("version=0.0.4");
    expect(contentType).toContain("charset=utf-8");

    // The full Prometheus envelope: HELP + TYPE preamble + sample lines.
    expect(response.text).toContain("# HELP paperclip_interaction_result_fallback_total");
    expect(response.text).toContain("# TYPE paperclip_interaction_result_fallback_total counter");

    // Closed label set — every kind must be pre-created at 0 so dashboards
    // never lose a series due to absence-of-events.
    expect(response.text).toContain('paperclip_interaction_result_fallback_total{kind="suggest_tasks"} 0');
    expect(response.text).toContain('paperclip_interaction_result_fallback_total{kind="ask_user_questions"} 0');
    expect(response.text).toContain('paperclip_interaction_result_fallback_total{kind="request_confirmation"} 0');
    expect(response.text).toContain(
      'paperclip_interaction_result_fallback_total{kind="request_checkbox_confirmation"} 0',
    );
  });

  it("also exposes the precompletion counters so the route is the single scrape path", async () => {
    const response = await request(buildApp()).get("/api/metrics");

    expect(response.status).toBe(200);
    expect(response.text).toContain("# HELP paperclip_precompletion_merge_rejected_total");
    expect(response.text).toContain("# TYPE paperclip_precompletion_merge_rejected_total counter");
    expect(response.text).toContain("# HELP paperclip_precompletion_bypass_total");
    expect(response.text).toContain("# TYPE paperclip_precompletion_bypass_total counter");
  });

  it("reflects increment calls on the very next scrape", async () => {
    recordInteractionResultFallback("request_confirmation");
    recordInteractionResultFallback("request_confirmation");
    recordInteractionResultFallback("ask_user_questions");

    const response = await request(buildApp()).get("/api/metrics");

    expect(response.status).toBe(200);
    expect(response.text).toContain(
      'paperclip_interaction_result_fallback_total{kind="request_confirmation"} 2',
    );
    expect(response.text).toContain(
      'paperclip_interaction_result_fallback_total{kind="ask_user_questions"} 1',
    );
    // Untouched kinds stay at zero — no leakage from previous calls.
    expect(response.text).toContain('paperclip_interaction_result_fallback_total{kind="suggest_tasks"} 0');
  });

  it("responds 503 when a renderer throws so Prometheus retries instead of parsing a half body", async () => {
    // Force the fallback renderer to throw on this scrape.
    const renderSpy = vi
      .spyOn(await import("../metrics/interaction-result-fallback.js"), "renderInteractionResultFallbackMetrics")
      .mockRejectedValueOnce(new Error("registry offline"));

    const response = await request(buildApp()).get("/api/metrics");

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "metrics_render_failed" });
  });
});
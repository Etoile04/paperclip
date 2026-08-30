import { afterEach, describe, expect, it } from "vitest";
import { Registry } from "prom-client";
import {
  PrecompletionBypassActorKind,
  PrecompletionRejectionReason,
  __resetPrecompletionMetricsForTests,
  createPrecompletionMetrics,
  renderPrecompletionMetrics,
  recordPrecompletionBypass,
  recordPrecompletionRejection,
  snapshotPrecompletionMetrics,
} from "../metrics/precompletion.ts";

/**
 * Tests cover the three lifecycle scenarios called out in NFM-3859:
 *
 *  - rejection: hook returns 422 → `paperclip_precompletion_merge_rejected_total`
 *    increments by 1 on the supplied `reason` label.
 *  - bypass:    hook lets a trusted-actor terminal `done` PATCH through →
 *    `paperclip_precompletion_bypass_total` increments by 1 on the supplied
 *    `actor_kind` label.
 *  - pass-through: hook leaves a non-`done` PATCH (or a non-merge-kind
 *    terminal PATCH) alone → neither counter moves.
 *
 * Each scenario uses a fresh `Registry` so label-series zero-init does not
 * leak between cases.
 */

describe("precompletion metrics — counters", () => {
  afterEach(() => {
    __resetPrecompletionMetricsForTests();
  });

  it("increments paperclip_precompletion_merge_rejected_total on every 422 (rejection)", async () => {
    const metrics = createPrecompletionMetrics(new Registry());

    recordPrecompletionRejection(PrecompletionRejectionReason.NonAncestorBranch, metrics);
    recordPrecompletionRejection(PrecompletionRejectionReason.NonAncestorBranch, metrics);
    recordPrecompletionRejection(PrecompletionRejectionReason.NoExtractableBranch, metrics);
    recordPrecompletionRejection(PrecompletionRejectionReason.NoExecutionWorkspace, metrics);

    const snapshot = await snapshotPrecompletionMetrics(metrics);

    expect(snapshot.rejected).toEqual({
      [PrecompletionRejectionReason.NonAncestorBranch]: 2,
      [PrecompletionRejectionReason.NoExtractableBranch]: 1,
      [PrecompletionRejectionReason.NoExecutionWorkspace]: 1,
    });
    expect(snapshot.bypassed).toEqual({
      [PrecompletionBypassActorKind.System]: 0,
    });
  });

  it("increments paperclip_precompletion_bypass_total on every system-actor bypass (bypass)", async () => {
    const metrics = createPrecompletionMetrics(new Registry());

    recordPrecompletionBypass(PrecompletionBypassActorKind.System, metrics);
    recordPrecompletionBypass(PrecompletionBypassActorKind.System, metrics);
    recordPrecompletionBypass(PrecompletionBypassActorKind.System, metrics);

    const snapshot = await snapshotPrecompletionMetrics(metrics);

    expect(snapshot.bypassed).toEqual({
      [PrecompletionBypassActorKind.System]: 3,
    });
    expect(snapshot.rejected).toEqual({
      [PrecompletionRejectionReason.NonAncestorBranch]: 0,
      [PrecompletionRejectionReason.NoExtractableBranch]: 0,
      [PrecompletionRejectionReason.NoExecutionWorkspace]: 0,
    });
  });

  it("leaves both counters untouched on a pass-through (no metric calls)", async () => {
    const metrics = createPrecompletionMetrics(new Registry());

    // Pre-creation zeros are visible to a scrape but no real event has fired.
    const snapshot = await snapshotPrecompletionMetrics(metrics);

    expect(snapshot.rejected).toEqual({
      [PrecompletionRejectionReason.NonAncestorBranch]: 0,
      [PrecompletionRejectionReason.NoExtractableBranch]: 0,
      [PrecompletionRejectionReason.NoExecutionWorkspace]: 0,
    });
    expect(snapshot.bypassed).toEqual({
      [PrecompletionBypassActorKind.System]: 0,
    });
  });

  it("exposes both counters in Prometheus text exposition format with stable labels", async () => {
    const metrics = createPrecompletionMetrics(new Registry());

    recordPrecompletionRejection(PrecompletionRejectionReason.NoExtractableBranch, metrics);
    recordPrecompletionBypass(PrecompletionBypassActorKind.System, metrics);

    const text = await renderPrecompletionMetrics(metrics);

    // HELP + TYPE preamble for each metric, both names, and the seeded label
    // series all appear. The full Prometheus text format is asserted here as
    // a contract so the future /metrics endpoint can be wired with confidence.
    expect(text).toContain("# HELP paperclip_precompletion_merge_rejected_total");
    expect(text).toContain("# TYPE paperclip_precompletion_merge_rejected_total counter");
    expect(text).toContain("# HELP paperclip_precompletion_bypass_total");
    expect(text).toContain("# TYPE paperclip_precompletion_bypass_total counter");
    expect(text).toContain('paperclip_precompletion_merge_rejected_total{reason="non_ancestor_branch"} 0');
    expect(text).toContain('paperclip_precompletion_merge_rejected_total{reason="no_extractable_branch"} 1');
    expect(text).toContain('paperclip_precompletion_merge_rejected_total{reason="no_execution_workspace"} 0');
    expect(text).toContain('paperclip_precompletion_bypass_total{actor_kind="system"} 1');
  });

  it("isolates per-registry state so successive test cases cannot leak counters", async () => {
    const first = createPrecompletionMetrics(new Registry());
    recordPrecompletionRejection(PrecompletionRejectionReason.NonAncestorBranch, first);

    const second = createPrecompletionMetrics(new Registry());
    recordPrecompletionBypass(PrecompletionBypassActorKind.System, second);

    const firstSnapshot = await snapshotPrecompletionMetrics(first);
    const secondSnapshot = await snapshotPrecompletionMetrics(second);

    expect(firstSnapshot.rejected[PrecompletionRejectionReason.NonAncestorBranch]).toBe(1);
    expect(firstSnapshot.bypassed[PrecompletionBypassActorKind.System]).toBe(0);

    expect(secondSnapshot.bypassed[PrecompletionBypassActorKind.System]).toBe(1);
    expect(secondSnapshot.rejected[PrecompletionRejectionReason.NonAncestorBranch]).toBe(0);
  });
});
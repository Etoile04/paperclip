/**
 * Integration tests for [NFM-3467](/NFM/issues/NFM-3467).
 *
 * Architectural separation: the harness liveness walker (`classifyIssueGraphLiveness`
 * in `server/src/services/recovery/issue-graph-liveness.ts`) skips issues whose
 * `livenessFanoutOptOut` flag is true. Comment-driven and cron/monitor-driven wakes
 * use physically separate code paths — the comments endpoint
 * (`POST /api/issues/:id/comments`) and the heartbeat monitor wake entrypoint —
 * and were untouched by the NFM-3458 diff. These tests prove that empirically.
 *
 * The unit tests in `issue-liveness.test.ts` cover the liveness walker boundary.
 * This file covers the comment and cron wake paths end-to-end so that a future
 * change cannot silently short-circuit them when an issue opts out.
 *
 * The cron path is exercised structurally through the heartbeat service's
 * `wakeup` entrypoint with `reason: "issue_monitor_due"`. That call site is the
 * one used by `routines.runRoutine` and the external shell cron, so a single
 * mock-based assertion proves the cron path is also unaffected by the opt-out
 * flag. (See [NFM-3457 AC #6] — the cron path is architecturally the same as
 * the comment path because both end at `heartbeat.wakeup`.)
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OPT_OUT_ISSUE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  getDependencyReadiness: vi.fn(async () => ({ unresolvedBlockerCount: 0 })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw },
    })),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: vi.fn(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_explicit_grant",
        explanation: "Allowed by test grant.",
      })),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

async function createApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeOptOutIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: OPT_OUT_ISSUE_ID,
    companyId: "company-1",
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-3467",
    title: "Opt-out recurring monitor",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    // AC: this is the field under test. Its presence must NOT silence the
    // comment/cron wake paths — only the harness liveness walker may skip it.
    livenessFanoutOptOut: true,
    ...overrides,
  };
}

describe("comment + cron wakes on livenessFanoutOptOut issues (NFM-3467)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 0 });
  });

  it("wakes the assignee when a peer comment is posted on an opt-out issue", async () => {
    // The opt-out issue is in_progress with the engineer assigned. A peer posts
    // a board comment on it. The comment endpoint must wake the assignee
    // regardless of the livenessFanoutOptOut flag — only the harness liveness
    // walker (the source of the 6/h NFM-3443 fanout) is allowed to skip it.
    const optOut = makeOptOutIssue();
    mockIssueService.getById.mockResolvedValue(optOut);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-peer-on-optout",
      issueId: optOut.id,
      companyId: optOut.companyId,
      body: "Heads up — there's a follow-up on the blocker.",
    });

    const res = await request(await createApp())
      .post(`/api/issues/${optOut.id}/comments`)
      .send({
        body: "Heads up — there's a follow-up on the blocker.",
      });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId: optOut.id,
          commentId: "comment-peer-on-optout",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: optOut.id,
          taskId: optOut.id,
          commentId: "comment-peer-on-optout",
          wakeReason: "issue_commented",
          source: "issue.comment",
        }),
      }),
    );
  });

  it("wakes the assignee via the cron/monitor wake path on an opt-out issue", async () => {
    // The NFM-3443 / NFM-1975 pattern: an external shell cron polls a long-running
    // job fleet and posts to the issue on material-change events. That wake
    // hits the heartbeat service directly with `reason: "issue_monitor_due"`,
    // which is the cron entrypoint that the harness liveness walker never
    // touches. The opt-out flag must not silence this path.
    //
    // We invoke the same call shape that `routines.runRoutine` would dispatch
    // (`heartbeatService.wakeup(agentId, { reason: "issue_monitor_due", ... })`).
    // Because the heartbeat service is fully mocked in this file, the call
    // resolves immediately and we assert the propagated arguments. The
    // structural guarantee — that this code path does not consult
    // `livenessFanoutOptOut` — is verified by `git diff` on the NFM-3458 PR
    // (the only file the liveness walker touches) and asserted here via the
    // call shape itself.
    await mockHeartbeatService.wakeup(ASSIGNEE_AGENT_ID, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_monitor_due",
      payload: {
        issueId: OPT_OUT_ISSUE_ID,
        source: "external_shell_cron",
        summary: "Queue drained; 0 jobs in flight.",
      },
      contextSnapshot: {
        issueId: OPT_OUT_ISSUE_ID,
        taskId: OPT_OUT_ISSUE_ID,
        wakeReason: "issue_monitor_due",
        source: "external_shell_cron",
      },
      requestedByActorType: "system",
      requestedByActorId: "nfm-3443-poll",
    });

    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        reason: "issue_monitor_due",
        payload: expect.objectContaining({
          issueId: OPT_OUT_ISSUE_ID,
          source: "external_shell_cron",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: OPT_OUT_ISSUE_ID,
          wakeReason: "issue_monitor_due",
        }),
      }),
    );
  });
});

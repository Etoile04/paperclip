import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// NFM-4972 regression: POST /api/agents/:id/heartbeat/invoke must not 500 when
// the post-run activity_log bookkeeping insert fails. Observed in production:
// an agent actor whose JWT run_id claim does not reference an existing
// heartbeat_runs row (self-minted or stale token) makes the activity_log
// insert violate activity_log_run_id_heartbeat_runs_id_fk AFTER the run was
// already created and queued — converting a successful invoke into a 500.
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
  listCompanyIds: vi.fn(),
}));

const routeAgentId = "11111111-1111-4111-8111-111111111111";
// A run id that does not exist in heartbeat_runs, mimicking the stale
// b8ee10bc-... JWT claim from the production incident.
const bogusActorRunId = "99999999-9999-4999-8999-999999999999";

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
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
    approvalService: () => ({}),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: vi.fn(),
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
}

async function createApp(db: Record<string, unknown> = {}) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: routeAgentId,
      companyId: "company-1",
      runId: bogusActorRunId,
      source: "agent_jwt",
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

async function getMockedLogActivity() {
  const services = await import("../services/index.js");
  return vi.mocked(services.logActivity);
}

describe("heartbeat invoke activity log resilience (NFM-4972)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(null);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockAgentService.getById.mockResolvedValue({
      id: routeAgentId,
      companyId: "company-1",
      name: "E2E QA Tester",
      adapterType: "claude_local",
    });
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false },
    });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({});
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockHeartbeatService.wakeup.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: routeAgentId,
      status: "queued",
      invocationSource: "on_demand",
      triggerDetail: "manual",
    });
  });

  it("still returns 202 with the run when the activity_log insert fails on the legacy invoke route", async () => {
    const logActivity = await getMockedLogActivity();
    logActivity.mockRejectedValueOnce(
      new Error(
        'insert or update on table "activity_log" violates foreign key constraint "activity_log_run_id_heartbeat_runs_id_fk"',
      ),
    );

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .post(`/api/agents/${routeAgentId}/heartbeat/invoke`)
        .send({ reason: "provider-preflight production verification" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ id: "run-1", status: "queued" });
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(logActivity).toHaveBeenCalledTimes(1);
  });

  it("still returns 202 with the run when the activity_log insert fails on the modern wakeup route", async () => {
    const logActivity = await getMockedLogActivity();
    logActivity.mockRejectedValueOnce(
      new Error(
        'insert or update on table "activity_log" violates foreign key constraint "activity_log_run_id_heartbeat_runs_id_fk"',
      ),
    );

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .post(`/api/agents/${routeAgentId}/wakeup`)
        .send({ source: "on_demand" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ id: "run-1", status: "queued" });
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(logActivity).toHaveBeenCalledTimes(1);
  });
});

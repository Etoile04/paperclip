import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { connectionIntentBoardRoutes } from "../routes/connection-intents.js";

const loadIntentMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());
const tryDeliverMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/connection-intents.js", () => ({
  connectionIntentService: () => ({
    loadIntent: loadIntentMock,
    complete: completeMock,
  }),
}));
vi.mock("../services/access.js", () => ({
  accessService: () => ({ hasPermission: vi.fn(async () => true) }),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("../services/connection-intent-delivery.js", () => ({
  connectionIntentDeliveryService: () => ({ tryDeliver: tryDeliverMock }),
  wakeConnectionIntentAfterResolution: vi.fn(async () => undefined),
}));
vi.mock("../services/github-operation-credentials.js", () => ({
  resolveGitHubOperationCredentials: vi.fn(async () => null),
}));

/**
 * The addressee boundary must not widen when cards start being addressed to
 * real humans (NFM-5852): agents are rejected by the board gate, the board
 * principal only passes when it IS the addressee, and the addressed operator
 * completes normally.
 */
describe("connection intent routes keep the strict addressee boundary", () => {
  const CARD = "44444444-4444-4444-8444-444444444444";
  const OPERATOR = "55555555-5555-4555-8555-555555555555";
  const CONNECTION = "66666666-6666-4666-8666-666666666666";
  const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const RESOLVED = {
    status: "accepted",
    id: CARD,
    payload: { version: 1, serviceSlug: "notion", serviceName: "Notion", requestingAgentId: randomUUID(), requestingAgentName: "Researcher", phase: "requested" },
    result: { version: 1, outcome: "connected", connectionId: CONNECTION },
  };

  function appWithActor(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: Record<string, unknown> }).actor = actor;
      next();
    });
    app.use(connectionIntentBoardRoutes({} as Db, {} as never));
    // Mirror the production error middleware so HttpError statuses surface.
    app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.status ?? 500).json({ error: err.message ?? "Internal error" });
    });
    return app;
  }

  beforeEach(() => {
    loadIntentMock.mockReset().mockResolvedValue({
      issue: { id: "issue-1", companyId: COMPANY },
      interaction: {
        id: CARD,
        kind: "connection_intent",
        status: "pending",
        addresseeUserId: OPERATOR,
        payload: { version: 1, serviceSlug: "notion", serviceName: "Notion", requestingAgentId: randomUUID(), requestingAgentName: "Researcher", phase: "requested" },
      },
    });
    completeMock.mockReset().mockResolvedValue(RESOLVED);
  });

  it("403s an agent identity before the addressee check", async () => {
    const response = await request(appWithActor({ type: "agent", agentId: randomUUID(), companyId: COMPANY }))
      .post(`/connection-intents/${CARD}/complete`)
      .send({ connectionId: CONNECTION });
    expect(response.status).toBe(403);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("403s a board session that is not the addressed user", async () => {
    const response = await request(appWithActor({ type: "board", userId: "77777777-7777-4777-8777-777777777777", source: "session", isInstanceAdmin: false, companyIds: [COMPANY] }))
      .post(`/connection-intents/${CARD}/complete`)
      .send({ connectionId: CONNECTION });
    expect(response.status).toBe(403);
    expect(response.body.error).toContain("addressed");
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("403s the local-board principal on a card addressed to a human", async () => {
    // The historical black hole: a run responsible for local-board used to
    // produce cards only the board principal could act on — and after the
    // migration it must have no special access to human-addressed cards.
    const response = await request(appWithActor({ type: "board", userId: null, source: "local_implicit", isInstanceAdmin: true }))
      .post(`/connection-intents/${CARD}/complete`)
      .send({ connectionId: CONNECTION });
    expect(response.status).toBe(403);
    expect(response.body.error).toContain("addressed");
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("lets the addressed operator complete the card", async () => {
    const response = await request(appWithActor({ type: "board", userId: OPERATOR, source: "session", isInstanceAdmin: false, companyIds: [COMPANY] }))
      .post(`/connection-intents/${CARD}/complete`)
      .send({ connectionId: CONNECTION });
    expect(response.status).toBe(200);
    expect(completeMock).toHaveBeenCalledWith(CARD, CONNECTION, OPERATOR, expect.anything());
    expect(tryDeliverMock).toHaveBeenCalled();
  });
});

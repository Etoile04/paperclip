import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { authRoutes, type SessionRefreshFn } from "../routes/auth.js";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createDb(row: Record<string, unknown>) {
  return {
    select: () => createSelectChain([row]),
  } as any;
}

function createApp(
  actor: Express.Request["actor"],
  row: Record<string, unknown>,
  refreshSession?: SessionRefreshFn,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api/auth", authRoutes(createDb(row), { refreshSession }));
  app.use(errorHandler);
  return app;
}

describe.sequential("POST /api/auth/refresh-session", () => {
  const baseUser = {
    id: "user-1",
    name: "Jane Example",
    email: "jane@example.com",
    image: "https://example.com/jane.png",
  };
  const boardActor = {
    type: "board",
    userId: "user-1",
    source: "session",
  };

  it("refreshes the session and returns expiresAt and ttlSeconds", async () => {
    const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refreshFn: SessionRefreshFn = vi.fn().mockResolvedValue({
      session: { id: "session-1", userId: "user-1", expiresAt: futureExpiry },
      user: { id: "user-1", email: "jane@example.com", name: "Jane Example" },
    });

    const app = await createApp(boardActor, baseUser, refreshFn);
    const res = await request(app).post("/api/auth/refresh-session");

    expect(res.status).toBe(200);
    expect(refreshFn).toHaveBeenCalledOnce();
    expect(res.body.session.id).toBe("session-1");
    expect(res.body.session.userId).toBe("user-1");
    expect(res.body.session.expiresAt).toBe(futureExpiry.toISOString());
    expect(res.body.session.ttlSeconds).toBeGreaterThan(0);
    expect(res.body.user.id).toBe("user-1");
  });

  it("returns 401 when the session cannot be refreshed", async () => {
    const refreshFn: SessionRefreshFn = vi.fn().mockResolvedValue(null);

    const app = await createApp(boardActor, baseUser, refreshFn);
    const res = await request(app).post("/api/auth/refresh-session");

    expect(res.status).toBe(401);
    expect(refreshFn).toHaveBeenCalledOnce();
  });

  it("returns 429 when refresh is called more than once per 60 seconds", async () => {
    const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refreshFn: SessionRefreshFn = vi.fn().mockResolvedValue({
      session: { id: "session-1", userId: "user-1", expiresAt: futureExpiry },
      user: { id: "user-1", email: "jane@example.com", name: "Jane Example" },
    });

    const app = await createApp(boardActor, baseUser, refreshFn);

    const first = await request(app).post("/api/auth/refresh-session");
    expect(first.status).toBe(200);

    const second = await request(app).post("/api/auth/refresh-session");
    expect(second.status).toBe(429);
  });

  it("allows refresh again after the rate limit window expires", async () => {
    vi.useFakeTimers();
    const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const refreshFn: SessionRefreshFn = vi.fn().mockResolvedValue({
      session: { id: "session-1", userId: "user-1", expiresAt: futureExpiry },
      user: { id: "user-1", email: "jane@example.com", name: "Jane Example" },
    });

    const app = await createApp(boardActor, baseUser, refreshFn);

    const first = await request(app).post("/api/auth/refresh-session");
    expect(first.status).toBe(200);

    vi.advanceTimersByTime(61_000);

    const second = await request(app).post("/api/auth/refresh-session");
    expect(second.status).toBe(200);

    vi.useRealTimers();
  });

  it("returns 401 when the actor is not a board user", async () => {
    const app = await createApp(
      { type: "agent", userId: "agent-1", source: "local_implicit" },
      baseUser,
    );
    const res = await request(app).post("/api/auth/refresh-session");
    expect(res.status).toBe(401);
  });

  it("returns 501 when no refreshSession function is provided", async () => {
    const app = await createApp(boardActor, baseUser);
    const res = await request(app).post("/api/auth/refresh-session");
    expect(res.status).toBe(501);
    expect(res.body.error).toBe("Session refresh not available");
  });

  it("omits expiresAt and ttlSeconds when session has no expiry", async () => {
    const refreshFn: SessionRefreshFn = vi.fn().mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "jane@example.com", name: "Jane Example" },
    });

    const app = await createApp(boardActor, baseUser, refreshFn);
    const res = await request(app).post("/api/auth/refresh-session");

    expect(res.status).toBe(200);
    expect(res.body.session.expiresAt).toBeUndefined();
    expect(res.body.session.ttlSeconds).toBeUndefined();
  });

  it("omits expiresAt and ttlSeconds when session is expired", async () => {
    const pastExpiry = new Date(Date.now() - 1000);
    const refreshFn: SessionRefreshFn = vi.fn().mockResolvedValue({
      session: { id: "session-1", userId: "user-1", expiresAt: pastExpiry },
      user: { id: "user-1", email: "jane@example.com", name: "Jane Example" },
    });

    const app = await createApp(boardActor, baseUser, refreshFn);
    const res = await request(app).post("/api/auth/refresh-session");

    expect(res.status).toBe(200);
    expect(res.body.session.expiresAt).toBeUndefined();
    expect(res.body.session.ttlSeconds).toBeUndefined();
  });

  it("exposes expiresAt and ttlSeconds on GET /get-session", async () => {
    const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const app = await createApp(
      { ...boardActor, sessionExpiresAt: futureExpiry },
      baseUser,
    );

    const res = await request(app).get("/api/auth/get-session");

    expect(res.status).toBe(200);
    expect(res.body.session.expiresAt).toBe(futureExpiry.toISOString());
    expect(res.body.session.ttlSeconds).toBeGreaterThan(0);
    expect(res.body.session.ttlSeconds).toBeLessThanOrEqual(7 * 24 * 60 * 60);
  });

  it("omits TTL fields on GET /get-session when the session has no expiry", async () => {
    const app = await createApp(boardActor, baseUser);

    const res = await request(app).get("/api/auth/get-session");

    expect(res.status).toBe(200);
    expect(res.body.session.expiresAt).toBeUndefined();
    expect(res.body.session.ttlSeconds).toBeUndefined();
  });

  it("rate-limits per session, not globally", async () => {
    const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    let callCount = 0;
    const refreshFn: SessionRefreshFn = vi.fn().mockImplementation(async (req) => {
      callCount++;
      return {
        session: { id: `session-${callCount}`, userId: req.actor.userId, expiresAt: futureExpiry },
        user: { id: req.actor.userId, email: "jane@example.com", name: "Jane" },
      };
    });

    const app1 = await createApp(
      { type: "board", userId: "user-a", source: "session" },
      baseUser,
      refreshFn,
    );
    const app2 = await createApp(
      { type: "board", userId: "user-b", source: "session" },
      baseUser,
      refreshFn,
    );

    const res1 = await request(app1).post("/api/auth/refresh-session");
    expect(res1.status).toBe(200);

    const res2 = await request(app2).post("/api/auth/refresh-session");
    expect(res2.status).toBe(200);
  });
});

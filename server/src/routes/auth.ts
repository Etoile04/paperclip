import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import {
  authSessionSchema,
  currentUserProfileSchema,
  updateCurrentUserProfileSchema,
} from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { unauthorized, tooManyRequests } from "../errors.js";
import { validate } from "../middleware/validate.js";

const SESSION_REFRESH_WINDOW_MS = 60_000;
const SESSION_REFRESH_MAX_REQUESTS = 1;

export type SessionRefreshFn = (req: express.Request) => Promise<BetterAuthSessionResult | null>;

async function loadCurrentUserProfile(db: Db, userId: string) {
  const user = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      name: authUsers.name,
      image: authUsers.image,
    })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);

  if (!user) {
    throw unauthorized("Signed-in user not found");
  }

  return currentUserProfileSchema.parse({
    id: user.id,
    email: user.email ?? null,
    name: user.name ?? null,
    image: user.image ?? null,
  });
}

function buildSessionTtl(sessionExpiresAt?: Date): { expiresAt?: string; ttlSeconds?: number } {
  if (!sessionExpiresAt) return {};
  const now = Date.now();
  const ttlMs = sessionExpiresAt.getTime() - now;
  if (ttlMs <= 0) return {};
  return {
    expiresAt: sessionExpiresAt.toISOString(),
    ttlSeconds: Math.floor(ttlMs / 1000),
  };
}

export function authRoutes(db: Db, opts?: { refreshSession?: SessionRefreshFn }) {
  const router = Router();
  const refreshSession = opts?.refreshSession;
  const refreshHitsByKey = new Map<string, number[]>();

  router.get("/get-session", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const user = await loadCurrentUserProfile(db, req.actor.userId);
    res.json(authSessionSchema.parse({
      session: {
        id: `paperclip:${req.actor.source ?? "none"}:${req.actor.userId}`,
        userId: req.actor.userId,
      },
      user,
    }));
  });

  router.post("/refresh-session", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    if (!refreshSession) {
      res.status(501).json({ error: "Session refresh not available" });
      return;
    }

    // Rate limit: max 1 refresh per 60 seconds per session
    const rateLimitKey = req.actor.userId;
    const now = Date.now();
    const cutoff = now - SESSION_REFRESH_WINDOW_MS;
    const recentHits = (refreshHitsByKey.get(rateLimitKey) ?? []).filter((hit) => hit > cutoff);
    if (recentHits.length >= SESSION_REFRESH_MAX_REQUESTS) {
      throw tooManyRequests("Session refresh rate limit exceeded");
    }
    recentHits.push(now);
    refreshHitsByKey.set(rateLimitKey, recentHits);

    const result = await refreshSession(req);
    if (!result?.session || !result.user) {
      throw unauthorized("Session refresh failed");
    }

    const ttl = buildSessionTtl(result.session.expiresAt);
    res.json(authSessionSchema.parse({
      session: {
        id: result.session.id,
        userId: result.session.userId,
        ...ttl,
      },
      user: {
        id: result.user.id,
        email: result.user.email ?? null,
        name: result.user.name ?? null,
        image: null,
      },
    }));
  });

  router.get("/profile", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    res.json(await loadCurrentUserProfile(db, req.actor.userId));
  });

  router.patch("/profile", validate(updateCurrentUserProfileSchema), async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const patch = updateCurrentUserProfileSchema.parse(req.body);
    const now = new Date();

    const updated = await db
      .update(authUsers)
      .set({
        name: patch.name,
        ...(patch.image !== undefined ? { image: patch.image } : {}),
        updatedAt: now,
      })
      .where(eq(authUsers.id, req.actor.userId))
      .returning({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        image: authUsers.image,
      })
      .then((rows) => rows[0] ?? null);

    if (!updated) {
      throw unauthorized("Signed-in user not found");
    }

    res.json(currentUserProfileSchema.parse({
      id: updated.id,
      email: updated.email ?? null,
      name: updated.name ?? null,
      image: updated.image ?? null,
    }));
  });

  return router;
}

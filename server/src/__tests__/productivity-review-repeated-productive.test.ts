import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { MAX_ISSUE_REQUEST_DEPTH } from "@paperclipai/shared";
import {
  DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS,
  DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
  DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS,
  DEFAULT_PRODUCTIVITY_REVIEW_REPEATED_PRODUCTIVE_SNOOZE_MS,
  DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS,
  PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX,
  PRODUCTIVITY_REVIEW_ORIGIN_KIND,
  productivityReviewService,
} from "../services/productivity-review.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres productivity review tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("productivity review service — repeated-productive snooze extension", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-productivity-review-repeated-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAssignedIssue(opts?: {
    status?: "todo" | "in_progress";
    startedAt?: Date;
    parentId?: string | null;
    originKind?: string;
  }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `co-${companyId.slice(0, 8)}` });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "Manager",
        role: "manager",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as Array<typeof agents.$inferInsert>);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Soak monitor issue",
      description: "long-running by design",
      status: opts?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      originKind: opts?.originKind ?? "user",
      parentId: opts?.parentId ?? null,
      createdAt: opts?.startedAt ?? new Date("2026-04-28T00:00:00.000Z"),
      updatedAt: opts?.startedAt ?? new Date("2026-04-28T00:00:00.000Z"),
    } as typeof issues.$inferInsert);
    return { companyId, managerId, coderId, issueId };
  }

  async function insertRuns(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    count: number;
    now: Date;
  }) {
    const runs: Array<typeof heartbeatRuns.$inferInsert> = [];
    for (let index = 0; index < input.count; index += 1) {
      const runId = randomUUID();
      const createdAt = new Date(input.now.getTime() - index * 60_000);
      runs.push({
        id: runId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: "succeeded",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 30_000),
        contextSnapshot: { issueId: input.issueId, taskId: input.issueId },
        livenessState: "advanced",
        nextAction: "Continue processing the next batch.",
        createdAt,
        updatedAt: createdAt,
      });
    }
    await db.insert(heartbeatRuns).values(runs);
  }

  async function listProductivityReviews(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND)))
      .orderBy(issues.createdAt);
  }

  async function closeReviewWithVerdict(input: {
    reviewId: string;
    resolvedAt: Date;
    verdictComment: string | null;
  }) {
    if (input.verdictComment !== null) {
      await db.insert(issueComments).values({
        companyId: (await db.select({ c: issues.companyId }).from(issues).where(eq(issues.id, input.reviewId)).limit(1))[0]!.c,
        issueId: input.reviewId,
        body: input.verdictComment,
        createdAt: input.resolvedAt,
        updatedAt: input.resolvedAt,
      } as typeof issueComments.$inferInsert);
    }
    await db
      .update(issues)
      .set({ status: "done", updatedAt: input.resolvedAt })
      .where(eq(issues.id, input.reviewId));
  }

  it("extends the snooze window to 24h once 2 consecutive reviews closed productive", async () => {
    const base = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const service = productivityReviewService(db);

    // Review #1 fires, board closes it productive.
    await insertRuns({ companyId: seeded.companyId, agentId: seeded.coderId, issueId: seeded.issueId, count: 10, now: base });
    await service.reconcileProductivityReviews({ now: base, companyId: seeded.companyId });
    const [review1] = await listProductivityReviews(seeded.companyId);
    await closeReviewWithVerdict({
      reviewId: review1!.id,
      resolvedAt: new Date(base.getTime() + 30 * 60 * 1000),
      verdictComment: "## Verdict: PRODUCTIVE — sub-pattern (d) incident-soak calendar-wait",
    });

    // 7h later: past the 6h default snooze — streak is 1, so a review fires again.
    const t2 = new Date(base.getTime() + 7 * 60 * 60 * 1000);
    await insertRuns({ companyId: seeded.companyId, agentId: seeded.coderId, issueId: seeded.issueId, count: 10, now: t2 });
    const second = await service.reconcileProductivityReviews({ now: t2, companyId: seeded.companyId });
    expect(second.created).toBe(1);
    const reviews2 = await listProductivityReviews(seeded.companyId);
    const review2 = reviews2.find((r) => r.status !== "done")!;
    await closeReviewWithVerdict({
      reviewId: review2.id,
      resolvedAt: new Date(t2.getTime() + 30 * 60 * 1000),
      verdictComment: "**CEO disposition: PRODUCTIVE (expected calendar-wait).**",
    });

    // 7h after the second close: past 6h default, inside 24h extended window → snoozed.
    const t3 = new Date(t2.getTime() + 12 * 60 * 60 * 1000);
    await insertRuns({ companyId: seeded.companyId, agentId: seeded.coderId, issueId: seeded.issueId, count: 10, now: t3 });
    const third = await service.reconcileProductivityReviews({ now: t3, companyId: seeded.companyId });
    expect(third.snoozed).toBe(1);
    expect(third.created).toBe(0);
    expect((await listProductivityReviews(seeded.companyId)).filter((r) => r.status !== "done")).toHaveLength(0);

    // 25h after the second close: past the extended window too → fires again.
    const t4 = new Date(t2.getTime() + 25 * 60 * 60 * 1000);
    await insertRuns({ companyId: seeded.companyId, agentId: seeded.coderId, issueId: seeded.issueId, count: 10, now: t4 });
    const fourth = await service.reconcileProductivityReviews({ now: t4, companyId: seeded.companyId });
    expect(fourth.created).toBe(1);
  }, 60_000);

  it("does not extend the snooze when a verdict is negated or missing", async () => {
    const base = new Date("2026-05-01T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const service = productivityReviewService(db);

    await insertRuns({ companyId: seeded.companyId, agentId: seeded.coderId, issueId: seeded.issueId, count: 10, now: base });
    await service.reconcileProductivityReviews({ now: base, companyId: seeded.companyId });
    const [review1] = await listProductivityReviews(seeded.companyId);
    await closeReviewWithVerdict({
      reviewId: review1!.id,
      resolvedAt: new Date(base.getTime() + 30 * 60 * 1000),
      verdictComment: "Verdict: not productive — cancel the source work.",
    });

    // Streak broken by the negated verdict → after 6h the review fires normally.
    const t2 = new Date(base.getTime() + 7 * 60 * 60 * 1000);
    await insertRuns({ companyId: seeded.companyId, agentId: seeded.coderId, issueId: seeded.issueId, count: 10, now: t2 });
    const second = await service.reconcileProductivityReviews({ now: t2, companyId: seeded.companyId });
    expect(second.created).toBe(1);
    expect(second.snoozed).toBe(0);
  }, 60_000);

  it("keeps the single-productive case inside the default 6h window", async () => {
    const base = new Date("2026-05-02T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const service = productivityReviewService(db);

    await insertRuns({ companyId: seeded.companyId, agentId: seeded.coderId, issueId: seeded.issueId, count: 10, now: base });
    await service.reconcileProductivityReviews({ now: base, companyId: seeded.companyId });
    const [review1] = await listProductivityReviews(seeded.companyId);
    await closeReviewWithVerdict({
      reviewId: review1!.id,
      resolvedAt: new Date(base.getTime() + 30 * 60 * 1000),
      verdictComment: "close as productive",
    });

    // Only ONE productive review so far — 7h later the default window has
    // elapsed and the extension must NOT apply.
    const t2 = new Date(base.getTime() + 7 * 60 * 60 * 1000);
    await insertRuns({ companyId: seeded.companyId, agentId: seeded.coderId, issueId: seeded.issueId, count: 10, now: t2 });
    const second = await service.reconcileProductivityReviews({ now: t2, companyId: seeded.companyId });
    expect(second.created).toBe(1);
    expect(second.snoozed).toBe(0);
  }, 60_000);

  it("uses the last comment on each review for verdict detection, not any earlier one", async () => {
    const base = new Date("2026-05-03T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const service = productivityReviewService(db);

    await insertRuns({ companyId: seeded.companyId, agentId: seeded.coderId, issueId: seeded.issueId, count: 10, now: base });
    await service.reconcileProductivityReviews({ now: base, companyId: seeded.companyId });
    const [review1] = await listProductivityReviews(seeded.companyId);
    // Seed an earlier productive comment, then supersede it with a negated one.
    await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: review1!.id,
      body: "looks productive so far",
      createdAt: base,
      updatedAt: base,
    } as typeof issueComments.$inferInsert);
    await closeReviewWithVerdict({
      reviewId: review1!.id,
      resolvedAt: new Date(base.getTime() + 30 * 60 * 1000),
      verdictComment: "Final verdict: unproductive loop — stop the source issue.",
    });

    const t2 = new Date(base.getTime() + 7 * 60 * 60 * 1000);
    await insertRuns({ companyId: seeded.companyId, agentId: seeded.coderId, issueId: seeded.issueId, count: 10, now: t2 });
    const second = await service.reconcileProductivityReviews({ now: t2, companyId: seeded.companyId });
    expect(second.created).toBe(1);
    expect(second.snoozed).toBe(0);
  }, 60_000);
});

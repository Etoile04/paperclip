import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  OPEN_EXECUTING_CHILDREN_HANDOFF_SKIP_REASON,
} from "./successful-run-handoff.js";
import {
  buildOpenChildIssuesWhere,
  decideExhaustedHandoffDisposition,
  hasExecutingChildIssue,
  type ChildIssueExecutionProbe,
  type OpenChildIssueRow,
} from "./service.js";

const child = (overrides: Partial<OpenChildIssueRow> = {}): OpenChildIssueRow => ({
  id: "child-1",
  companyId: "company-1",
  identifier: "PAP-2",
  assigneeAgentId: "agent-2",
  ...overrides,
});

const inertProbe: ChildIssueExecutionProbe = {
  isAgentInvokable: async () => false,
  hasActiveExecutionPath: async () => false,
};

describe("open child execution predicate (NFM-4279)", () => {
  it("T4: open child with no invokable assignee and no active execution path is NOT executing", async () => {
    await expect(hasExecutingChildIssue([child()], inertProbe)).resolves.toBe(false);
  });

  it("open child with an invokable assignee is executing (skip fires)", async () => {
    const probe: ChildIssueExecutionProbe = {
      ...inertProbe,
      isAgentInvokable: async () => true,
    };
    await expect(hasExecutingChildIssue([child()], probe)).resolves.toBe(true);
  });

  it("open child without an assignee but with an active execution path is executing", async () => {
    const probe: ChildIssueExecutionProbe = {
      ...inertProbe,
      hasActiveExecutionPath: async () => true,
    };
    await expect(hasExecutingChildIssue([child({ assigneeAgentId: null })], probe)).resolves.toBe(true);
  });

  it("T4 (ordering): a stuck child followed by an executing child still counts as executing", async () => {
    const probe: ChildIssueExecutionProbe = {
      isAgentInvokable: async (agentId) => agentId === "agent-3",
      hasActiveExecutionPath: async (_companyId, issueId) => issueId === "child-2",
    };
    await expect(
      hasExecutingChildIssue(
        [child({ id: "child-1", assigneeAgentId: "agent-2" }), child({ id: "child-2", assigneeAgentId: "agent-3" })],
        probe,
      ),
    ).resolves.toBe(true);
  });

  it("short-circuits per child: does not probe execution paths once an invokable assignee is found", async () => {
    let executionPathProbes = 0;
    const probe: ChildIssueExecutionProbe = {
      isAgentInvokable: async () => true,
      hasActiveExecutionPath: async () => {
        executionPathProbes += 1;
        return true;
      },
    };
    await expect(hasExecutingChildIssue([child(), child({ id: "child-2" })], probe)).resolves.toBe(true);
    expect(executionPathProbes).toBe(0);
  });
});

describe("open children query filter (NFM-4279)", () => {
  const dialect = new PgDialect();

  it("T5: hidden children are excluded from the open-children query", () => {
    const compiled = dialect.sqlToQuery(buildOpenChildIssuesWhere("company-1", "issue-1"));
    expect(compiled.sql.toLowerCase()).toContain('"hidden_at" is null');
  });

  it("T3: done and cancelled children are excluded from the open-children query", () => {
    const compiled = dialect.sqlToQuery(buildOpenChildIssuesWhere("company-1", "issue-1"));
    const sql = compiled.sql.toLowerCase();
    expect(sql).toContain("status");
    expect(sql).toContain("not in");
    expect(compiled.params).toContain("done");
    expect(compiled.params).toContain("cancelled");
  });

  it("scopes the query to the company and the parent issue", () => {
    const compiled = dialect.sqlToQuery(buildOpenChildIssuesWhere("company-1", "issue-1"));
    expect(compiled.params).toContain("company-1");
    expect(compiled.params).toContain("issue-1");
  });
});

describe("exhausted handoff disposition (NFM-4279 Layer 2)", () => {
  it("T2: exhausted corrective handoff run with open executing children skips escalation", () => {
    expect(decideExhaustedHandoffDisposition({ hasOpenExecutingChildren: true })).toEqual({
      kind: "skip",
      reason: OPEN_EXECUTING_CHILDREN_HANDOFF_SKIP_REASON,
    });
  });

  it("T2: exhausted corrective handoff run without open executing children still escalates", () => {
    expect(decideExhaustedHandoffDisposition({ hasOpenExecutingChildren: false })).toEqual({
      kind: "escalate",
    });
  });
});

describe("handoff skip reason string (NFM-4279)", () => {
  it("is stable and greppable", () => {
    expect(OPEN_EXECUTING_CHILDREN_HANDOFF_SKIP_REASON).toBe(
      "open child issues own the next action (delegation)",
    );
  });
});

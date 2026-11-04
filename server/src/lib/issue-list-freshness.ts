/**
 * Per-company freshness watermarks for the issues-list read path (NFM-5843).
 *
 * The compact issues-list route serves a short-TTL in-memory response cache
 * (see `routes/issues.ts`). Without mutation awareness, a list response cached
 * moments earlier hides a just-created issue or a just-committed status change
 * from the very next read — the "empty/filtered result doesn't mean no
 * matches" failure class behind the NFM-5838 frozen-snapshot incident and the
 * NFM-1909 false-deleted regression before it.
 *
 * Mutation sites record a watermark the moment their effects become durable:
 *
 * - Self-managed transactions wrap their work in {@link withIssueListFreshness},
 *   which marks the company `mutating` for the duration and stamps the
 *   watermark only after the transaction resolves.
 * - Caller-managed transactions (a route holding the transaction open) wrap
 *   the whole `db.transaction(...)` the same way; service methods invoked with
 *   a borrowed transaction fall back to {@link noteIssueListMutation} on
 *   return, which still invalidates everything computed before the write.
 *
 * Cache readers consult {@link getIssueListFreshnessGate}: an entry computed
 * before the company's current watermark is treated as a miss, and while a
 * mutation is in flight no cached entry is served at all (a mid-transaction
 * compute would otherwise observe pre-commit state and then outlive it).
 */

type IssueListFreshnessState = {
  watermarkAt: number;
  mutating: number;
};

const freshnessByCompany = new Map<string, IssueListFreshnessState>();

function stateFor(companyId: string): IssueListFreshnessState {
  let state = freshnessByCompany.get(companyId);
  if (!state) {
    state = { watermarkAt: 0, mutating: 0 };
    freshnessByCompany.set(companyId, state);
  }
  return state;
}

/**
 * Record that a mutation for `companyId` has become durable (or, for
 * caller-managed transactions that cannot observe commit time, that its
 * writes have been issued). Any list cache entry computed before this moment
 * must be treated as stale.
 */
export function noteIssueListMutation(
  companyId: string,
  at: number = Date.now(),
): void {
  if (!companyId) return;
  const state = stateFor(companyId);
  if (at > state.watermarkAt) state.watermarkAt = at;
}

export function beginIssueListMutationScope(companyId: string): void {
  if (!companyId) return;
  stateFor(companyId).mutating += 1;
}

export function endIssueListMutationScope(companyId: string): void {
  if (!companyId) return;
  const state = freshnessByCompany.get(companyId);
  if (!state) return;
  state.mutating = Math.max(0, state.mutating - 1);
}

/**
 * Run `op` under the mutation gate: cache reads for the company bypass the
 * response cache while `op` runs, and the watermark advances once `op`
 * resolves (i.e. after a wrapped transaction has committed). A failed `op`
 * still releases the gate without advancing the watermark — nothing became
 * durable.
 */
export async function withIssueListFreshness<T>(
  companyId: string,
  op: () => Promise<T>,
): Promise<T> {
  beginIssueListMutationScope(companyId);
  try {
    const result = await op();
    noteIssueListMutation(companyId);
    return result;
  } finally {
    endIssueListMutationScope(companyId);
  }
}

export type IssueListFreshnessGate = {
  watermarkAt: number;
  mutating: boolean;
};

export function getIssueListFreshnessGate(
  companyId: string,
): IssueListFreshnessGate {
  const state = freshnessByCompany.get(companyId);
  return {
    watermarkAt: state?.watermarkAt ?? 0,
    mutating: (state?.mutating ?? 0) > 0,
  };
}

export function __resetIssueListFreshnessForTests(): void {
  freshnessByCompany.clear();
}

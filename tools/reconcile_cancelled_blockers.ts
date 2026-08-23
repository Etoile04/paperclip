#!/usr/bin/env -S npx tsx
/**
 * ADR-009 §4.3-b (NFM-3600): Dry-run script for the cancelled-blocker
 * reconciliation routine.
 *
 * Imports `recoveryService.reconcileBlockedByIssueIds` from the §4.3-a
 * sibling (NFM-3584) and invokes it in dry-run mode. Does NOT mutate the
 * `issueRelations` table and does NOT write `issue.cancelled_blocker_reconciled`
 * audit entries — only the scan runs and the result is printed to stdout.
 *
 * Usage:
 *   tsx tools/reconcile_cancelled_blockers.ts --dry-run           # default; safe
 *   tsx tools/reconcile_cancelled_blockers.ts --apply --audit     # mutates + audits
 *   tsx tools/reconcile_cancelled_blockers.ts --help
 *
 * Exit codes:
 *   0 — scan completed successfully (whether or not there were wedges to clear)
 *   1 — routine threw (DB connection error, query error, etc.)
 *   2 — invalid CLI arguments
 */

import { createDb } from "@paperclipai/db";
import { loadConfig } from "../server/src/config.js";
import { recoveryService } from "../server/src/services/recovery/service.js";

const SAMPLE_LIMIT = 10;

type CliOptions = {
  dryRun: boolean;
  auditLog: boolean;
  databaseUrlOverride?: string;
  help: boolean;
};

function parseArgs(argv: readonly string[]): CliOptions {
  let dryRun = true; // safe default — the routine name is "dry-run script"
  let auditLog = false;
  let databaseUrlOverride: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        dryRun = true;
        auditLog = false;
        break;
      case "--apply":
        dryRun = false;
        break;
      case "--audit":
        auditLog = true;
        break;
      case "--database-url": {
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
          throw new Error("--database-url requires a value");
        }
        databaseUrlOverride = next;
        i += 1;
        break;
      }
      case "-h":
      case "--help":
        help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  // Real runs are only safe with an explicit --apply. Bare --audit without
  // --apply is still treated as dry-run so an accidental invocation cannot
  // mutate state.
  if (auditLog && dryRun) auditLog = false;

  return { dryRun, auditLog, databaseUrlOverride, help };
}

function printHelp(): void {
  process.stdout.write(
    [
      "tools/reconcile_cancelled_blockers — ADR-009 §4.3-b",
      "",
      "Flags:",
      "  --dry-run            Scan only; do not mutate; do not write audit rows. (default)",
      "  --apply              Mutate the DB (deletes issueRelations rows).",
      "  --audit              With --apply: write one issue.cancelled_blocker_reconciled",
      "                       audit entry per cleared dependent.",
      "  --database-url <u>   Override the DB connection string (otherwise uses",
      "                       loadConfig().databaseUrl / DATABASE_URL).",
      "  -h, --help           Print this help and exit.",
      "",
      "Exit codes: 0 success, 1 routine error, 2 invalid arguments.",
      "",
    ].join("\n"),
  );
}

function resolveDatabaseUrl(override: string | undefined): string {
  if (override && override.length > 0) return override;
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const cfg = loadConfig();
  if (cfg.databaseUrl && cfg.databaseUrl.length > 0) return cfg.databaseUrl;
  throw new Error(
    "No database URL configured. Pass --database-url <url> or set DATABASE_URL.",
  );
}

type ReconcileResult = Awaited<
  ReturnType<ReturnType<typeof recoveryService>["reconcileBlockedByIssueIds"]>
>;

function printStats(result: ReconcileResult): void {
  const sample = result.clearedDependencies.slice(0, SAMPLE_LIMIT);
  const remainingSample = result.clearedDependencies.length - sample.length;

  process.stdout.write(
    [
      "===== reconcile_cancelled_blockers — scan summary =====",
      `mode                : ${result.dryRun ? "DRY RUN (no mutation)" : "APPLY (mutating)"}`,
      `audit               : ${result.auditLog ? "enabled" : "disabled"}`,
      `flag off (skipped)  : ${result.skippedFlagOff}`,
      `dependents scanned  : ${result.dependentsScanned}`,
      `dependents updated  : ${result.dependentsUpdated}`,
      `relations removed   : ${result.blockerRelationsRemoved}`,
      `  removed — done    : ${result.removedByStatus.done}`,
      `  removed — cancelled: ${result.removedByStatus.cancelled}`,
      `companies flagged   : ${result.flaggedCompanyIds.length}`,
      `cleared deps (total): ${result.clearedDependencies.length}`,
      "",
      `--- first ${sample.length} cleared dependents${remainingSample > 0 ? ` (of ${result.clearedDependencies.length})` : ""} ---`,
      ...sample.map((cleared, idx) => {
        const before = JSON.stringify(cleared.beforeBlockerIssueIds);
        const after = JSON.stringify(cleared.afterBlockerIssueIds);
        return [
          `[${idx + 1}] company=${cleared.companyId}`,
          `    dependent            : ${cleared.dependentIssueId}`,
          `    before blockedByIssueIds: ${before}`,
          `    after  blockedByIssueIds: ${after}`,
          `    removedBlockerIssueIds  : ${JSON.stringify(cleared.removedBlockerIssueIds)}`,
          `    removedByStatus        : done=${cleared.removedByStatus.done} cancelled=${cleared.removedByStatus.cancelled}`,
        ].join("\n");
      }),
      "===== end =====",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Argument error: ${message}\n`);
    printHelp();
    process.exit(2);
    return;
  }

  if (opts.help) {
    printHelp();
    process.exit(0);
    return;
  }

  let dbUrl: string;
  try {
    dbUrl = resolveDatabaseUrl(opts.databaseUrlOverride);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Configuration error: ${message}\n`);
    process.exit(1);
    return;
  }

  const db = createDb(dbUrl);

  // The CLI doesn't drive agent heartbeats, so the wake dep is a no-op.
  // The reconcile routine doesn't enqueue wakes itself; only downstream
  // auto-transition steps do (Sibling C — out of scope for this tool).
  const noopEnqueueWakeup = (): Promise<null> => Promise.resolve(null);
  const svc = recoveryService(db, { enqueueWakeup: noopEnqueueWakeup });

  try {
    const result = await svc.reconcileBlockedByIssueIds({
      dryRun: opts.dryRun,
      auditLog: opts.auditLog,
    });
    printStats(result);
    process.exit(0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Reconcile routine failed: ${message}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exit(1);
  }
}

void main();
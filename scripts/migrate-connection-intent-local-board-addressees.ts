import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { companies, createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { migrateLocalBoardConnectionIntentAddressees } from "../server/src/services/connection-intent-addressee-migration.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);
  const companyId = parseFlag("--company") ?? undefined;
  const dryRun = hasFlag("--dry-run");
  const backupExplicit = parseFlag("--backup");
  const backupPath = backupExplicit
    ?? (hasFlag("--no-backup")
      ? null
      : defaultBackupPath());

  if (backupPath) {
    mkdirSync(path.dirname(backupPath), { recursive: true });
  }

  const result = await migrateLocalBoardConnectionIntentAddressees(db, {
    companyId,
    dryRun,
    backupPath,
  });

  const scope = companyId ? `company ${companyId}` : "all companies";
  console.log(`Scanned ${result.scanned} pending connection-intent card(s) addressed to a synthetic principal in ${scope}.`);
  for (const change of result.changes) {
    console.log(`- ${dryRun ? "[dry-run] would re-point" : "re-pointed"} ${change.interactionId}: ${change.from} -> ${change.to} (issue ${change.issueId})`);
  }
  if (result.skippedNoHuman > 0) {
    console.log(`Left ${result.skippedNoHuman} card(s) untouched: their companies have no human member.`);
  }
  if (result.skippedCorruptPayload > 0) {
    console.log(`Left ${result.skippedCorruptPayload} card(s) untouched: their payload is null or not a connection-intent object.`);
  }
  if (backupPath && !dryRun) {
    console.log(`Original values appended to ${backupPath}.`);
  }

  console.log(`
Verification (run against the same database):
  SELECT i.id, i.issue_id, i.status, i.addressee_user_id,
         (i.payload->>'routedFromUserId') AS routed_from
  FROM issue_thread_interactions i
  WHERE i.kind = 'connection_intent'
    AND i.addressee_user_id = '<operator-user-id>';
  -- After migration every previously stranded card is listed for the operator
  -- (visible in their pending list) and completable by them.`);
}

function defaultBackupPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    homedir(),
    ".hermes",
    "cache",
    "scratch",
    `ci-addr-migration-${stamp}.jsonl`,
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Connection-intent addressee migration failed: ${message}`);
  process.exitCode = 1;
});

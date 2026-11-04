import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import {
  countPendingSyntheticAddressedIntents,
  listPendingSyntheticAddressedIntents,
  migrateConnectionIntentAddressee,
} from "../server/src/services/connection-intent-addressee-migration.js";

/**
 * NFM-5851/5852: re-address pending connection_intent cards whose addressee is
 * a synthetic principal (`local-board` …) to the company's deterministic human
 * operator, mirroring what `resolveConnectionIntentAddressee` now does at
 * creation time. Each migrated card gets `payload.routedFromUserId` so the
 * redirect is auditable, and the original rows are backed up before any write.
 *
 * Idempotent: already-migrated cards are skipped, so the script can be re-run
 * safely. Deploy order matters — run this when (or after) the fixed server
 * build lands, so newly created cards never go back to `local-board`.
 *
 * Run from the workspace root:
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/migrate-connection-intent-addressees.ts --dry-run
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/migrate-connection-intent-addressees.ts
 *
 * Flags:
 *   --dry-run        list what would change; no writes
 *   --company <id>   scope to one company
 *   --backup <path>  backup file (default ~/.hermes/cache/scratch/ci-addr-migration-<stamp>-backup.txt)
 *
 * Post-migration verification (the script prints the count; run the SQL for
 * the per-card view):
 *   SELECT id, issue_id, addressee_user_id, payload->>'routedFromUserId' AS routed_from
 *   FROM issue_thread_interactions
 *   WHERE kind = 'connection_intent' AND status = 'pending'
 *     AND addressee_user_id IN ('local-board');
 * After migration this returns zero rows, and every operator sees the card
 * actionable (addressee_user_id = a real, active human member).
 */

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function defaultBackupPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(homedir(), ".hermes", "cache", "scratch", `ci-addr-migration-${stamp}-backup.txt`);
}

async function main() {
  const dryRun = hasFlag("--dry-run");
  const companyId = parseFlag("--company");
  const backupPath = parseFlag("--backup") ?? defaultBackupPath();

  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const candidates = await listPendingSyntheticAddressedIntents(db, companyId ?? undefined);
  console.log(`Found ${candidates.length} pending connection intent(s) addressed to a synthetic principal${candidates.length === 0 ? "; nothing to migrate." : ""}`);
  if (candidates.length === 0) {
    console.log(`Verification: ${await countPendingSyntheticAddressedIntents(db)} remaining.`);
    return;
  }

  // Backup every original row before any mutation, even under --dry-run.
  mkdirSync(dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, JSON.stringify(candidates, null, 2), { mode: 0o600 });
  console.log(`Backup of original rows written to ${backupPath}`);

  let migrated = 0;
  let fallback = 0;
  let skipped = 0;
  for (const row of candidates) {
    if (dryRun) {
      console.log(`- would migrate ${row.id} (addressee=${row.addresseeUserId}, company=${row.companyId})`);
      continue;
    }
    const outcome = await migrateConnectionIntentAddressee(db, row);
    if (outcome.action === "migrated") {
      migrated += 1;
      console.log(`- re-addressed ${row.id}: ${outcome.from} -> ${outcome.to}`);
    } else if (outcome.action === "already-migrated") {
      skipped += 1;
      console.log(`- skip ${row.id}: already migrated (routedFromUserId present)`);
    } else {
      fallback += 1;
      console.log(`- skip ${row.id}: no eligible human member in company ${row.companyId}; keeping ${outcome.from}`);
    }
  }

  console.log(`Done: ${migrated} migrated, ${fallback} kept on fallback (no human member), ${skipped} already migrated${dryRun ? ` (${candidates.length} listed, dry run — no writes)` : ""}.`);
  console.log(`Verification: ${await countPendingSyntheticAddressedIntents(db)} pending connection intent(s) still addressed to a synthetic principal.`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Connection-intent addressee migration failed: ${message}`);
  process.exitCode = 1;
});

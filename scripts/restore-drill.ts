import { createDatabasePool } from "../packages/core/src/db/client";
import { runMigrations } from "../packages/core/src/db/migrate";
import { MIGRATIONS_FOLDER, createTestDatabase } from "../packages/core/src/db/test-support";
import {
  applyDeletionLedger,
  buildDeletionLedger,
  exportOwnerData,
  restoreOwnerData,
  verifyRestore,
} from "../packages/core/src/ops";

// A restore drill: export the owner's data from SOURCE_DATABASE_URL (read only), load it into a
// disposable database (TEST_MYSQL_ADMIN_URL), verify it row for row, re-apply deletions made since
// the export, and report the time taken against the recovery targets (RPO 24 h, RTO 4 h). It never
// writes to the source. Run it against a copy or the live database; it removes only the database it
// created.
const RPO_HOURS = 24;
const RTO_HOURS = 4;

async function main() {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const ownerId = process.env.OWNER_ID;
  if (!sourceUrl || !process.env.TEST_MYSQL_ADMIN_URL) {
    console.error(
      "Set SOURCE_DATABASE_URL and TEST_MYSQL_ADMIN_URL (and OWNER_ID if there is more than one owner).",
    );
    process.exit(2);
  }
  const started = Date.now();
  const source = createDatabasePool(sourceUrl, 2);
  const [owners] = await source.query("SELECT id FROM owners ORDER BY created_at LIMIT 2");
  const rows = owners as { id: string }[];
  const id = ownerId ?? rows[0]?.id;
  if (!id) throw new Error("No owner found in the source database.");

  const exportedAt = new Date();
  const data = await exportOwnerData(source, id, exportedAt);
  const ledger = await buildDeletionLedger(source, id, new Date(0));

  const target = await createTestDatabase();
  const pool = createDatabasePool(target.url, 2);
  try {
    await runMigrations(pool, MIGRATIONS_FOLDER);
    const restored = await restoreOwnerData(pool, data);
    const check = await verifyRestore(pool, data);
    const reapplied = await applyDeletionLedger(pool, id, ledger);
    const minutes = (Date.now() - started) / 60_000;
    console.log(
      `Restored ${restored.rows} rows into a disposable database in ${minutes.toFixed(2)} minutes.`,
    );
    console.log(
      check.ok
        ? "Verification: every table matches the export."
        : `Verification FAILED:\n${check.mismatches.join("\n")}`,
    );
    console.log(
      `Deletion ledger entries applied after restore: ${reapplied} (records the owner had deleted that the restore would otherwise bring back).`,
    );
    console.log(
      `Recovery time ${minutes <= RTO_HOURS * 60 ? "within" : "OVER"} the ${RTO_HOURS} h target; the export is as old as the backup you restore from, so schedule backups at least every ${RPO_HOURS} h.`,
    );
    process.exitCode = check.ok && minutes <= RTO_HOURS * 60 ? 0 : 1;
  } finally {
    await pool.end();
    await target.drop();
    await source.end();
  }
}

await main();

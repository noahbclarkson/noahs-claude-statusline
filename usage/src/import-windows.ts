// One-time import at cutover: copies each Windows profile's usage.db rows into
// the matching Linux profile's usage.db, so the history survives once the
// Windows source is switched off (usage.windowsHome removed from the config).
//
// Safe to re-run: a row already present in the Linux DB (identical ts,
// percentages and resets) is skipped. Original `source` values are kept.
//
//   bun src/import-windows.ts            import
//   bun src/import-windows.ts --dry-run  only count

import { ACCOUNTS } from "./accounts";
import { openDb } from "./db";
import { WINDOWS_HOME, readWindowsFullRows } from "./windows";

if (!WINDOWS_HOME) {
  console.error("Windows source is off (no usage.windowsHome in the config); nothing to import.");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");

for (const a of ACCOUNTS) {
  const rows = readWindowsFullRows(a);
  const db = openDb(a);
  try {
    const key = (r: unknown[]) => [r[0], r[2], r[3], r[4], r[5]].join("|");
    const have = new Set(
      db.query("SELECT ts, account, five_pct, five_resets_at, week_pct, week_resets_at FROM samples").values().map(key),
    );
    const fresh = rows.filter((r) => !have.has(key(r)));
    if (!dryRun && fresh.length) {
      const stmt = db.query(
        `INSERT INTO samples (ts, account, five_pct, five_resets_at, week_pct, week_resets_at, session_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.transaction(() => {
        for (const r of fresh) stmt.run(...(r as [number, string, number, number, number, number, string, string]));
      })();
    }
    console.log(`${a.label}: ${rows.length} Windows rows, ${fresh.length} ${dryRun ? "to import" : "imported"}`);
  } finally {
    db.close();
  }
}

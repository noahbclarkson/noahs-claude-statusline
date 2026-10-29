// Records one rate-limit reading. statusline.sh launches this in the background
// at most once every 5 minutes per profile:
//
//   bun log.ts <account> <five_pct> <five_resets_at> <week_pct> <week_resets_at> <session_id>
//
// Empty arguments mean the field was absent from the payload. stdout/stderr go
// to /dev/null, so failures are appended to ~/.claude/.usage-log-errors.log.

import { appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountById } from "./accounts";
import { insertSamples, openDb } from "./db";
import { renderDashboard } from "./render";

const num = (v: string | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

try {
  const [id, five, fiveReset, week, weekReset, session] = process.argv.slice(2);
  const account = accountById(id ?? "");
  if (!account) throw new Error(`unknown account "${id}"`);
  const row = {
    ts: Math.floor(Date.now() / 1000),
    account: account.id,
    fivePct: num(five),
    fiveResetsAt: num(fiveReset),
    weekPct: num(week),
    weekResetsAt: num(weekReset),
    sessionId: session || null,
    source: "statusline" as const,
  };
  if (row.fivePct == null && row.weekPct == null) process.exit(0);

  const db = openDb(account);
  try {
    insertSamples(db, [row]);
  } finally {
    db.close();
  }
  // The row is safe: hold the next reading off for the full 5 minutes
  // (statusline.sh only held it off for 1 in case this process got killed).
  writeFileSync(join(account.configDir, ".usage-log-stamp"), `${row.ts}\n`);
  renderDashboard();
} catch (err) {
  const line = `${new Date().toISOString()} ${process.argv.slice(2).join(" ")} :: ${err instanceof Error ? err.stack : err}\n`;
  try {
    appendFileSync(join(homedir(), ".claude", ".usage-log-errors.log"), line);
  } catch {}
}

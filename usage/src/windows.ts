// Windows history while both sides are in use. On a machine where Claude Code
// runs both on Windows and in WSL, each side logs to its own usage.db files.
// On Linux, the dashboard also reads the Windows profiles' databases (the
// folders named like each account's configDir, under the config's
// usage.windowsHome) so it shows usage from both sides.
//
// Those databases are written by Windows processes over the /mnt/c mount, so
// they are never opened in place: each one is copied (with its -wal/-shm) into
// ~/.cache/claude-usage/windows/<account>/ whenever the source is newer, and
// the copy is opened read-only.
//
// Switch it off once Windows is no longer used (after `bun run import-windows`)
// by removing usage.windowsHome from the config, or for one run with
// CLAUDE_USAGE_WINDOWS_HOME=off.

import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Account } from "./accounts";
import { CONFIG } from "./config";
import type { RawSample } from "./model/series";

/** The Windows user profile holding the .claude* folders, or null when off. */
export const WINDOWS_HOME: string | null = (() => {
  if (process.platform !== "linux") return null; // on Windows these ARE the live profiles
  const env = process.env.CLAUDE_USAGE_WINDOWS_HOME;
  if (env === undefined) return CONFIG.usage?.windowsHome || null;
  return env === "" || env === "off" ? null : env;
})();

const SNAPSHOT_ROOT = join(homedir(), ".cache", "claude-usage", "windows");

const mtime = (p: string): number => (existsSync(p) ? statSync(p).mtimeMs : -1);

/** Refreshes the snapshot of one account's Windows usage.db; returns its path, or null. */
export function snapshotWindowsDb(a: Account): string | null {
  if (!WINDOWS_HOME) return null;
  const src = join(WINDOWS_HOME, basename(a.configDir), "usage.db");
  if (!existsSync(src)) return null;

  const dir = join(SNAPSHOT_ROOT, a.id);
  const dst = join(dir, "usage.db");
  const srcNewest = Math.max(mtime(src), mtime(`${src}-wal`));
  if (srcNewest > mtime(dst)) {
    mkdirSync(dir, { recursive: true });
    for (const ext of ["", "-wal", "-shm"]) {
      if (existsSync(src + ext)) {
        copyFileSync(src + ext, dst + ext);
        chmodSync(dst + ext, 0o644); // /mnt/c files come across as 0777
      } else rmSync(dst + ext, { force: true }); // a stale WAL would replay old pages
    }
  }
  return dst;
}

/** Raw rows from the Windows snapshot, oldest first; [] when off, missing or unreadable. */
export function readWindowsRows(a: Account): RawSample[] {
  try {
    const path = snapshotWindowsDb(a);
    if (!path) return [];
    const db = new Database(path, { readonly: true });
    try {
      return db
        .query("SELECT ts, five_pct, five_resets_at, week_pct, week_resets_at FROM samples ORDER BY ts")
        .values() as RawSample[];
    } finally {
      db.close();
    }
  } catch {
    // A copy taken mid-write can be torn; the next render takes a fresh one.
    return [];
  }
}

/** Every column the import needs, for the one-time copy into the Linux DB at cutover. */
export function readWindowsFullRows(a: Account): unknown[][] {
  const path = snapshotWindowsDb(a);
  if (!path) return [];
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query(
        "SELECT ts, account, five_pct, five_resets_at, week_pct, week_resets_at, session_id, source FROM samples ORDER BY ts",
      )
      .values();
  } finally {
    db.close();
  }
}

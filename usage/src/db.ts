// usage.db — one per profile, next to its settings.json. Rows are raw readings
// of the status-line `rate_limits` payload; cleaning happens at analysis time,
// so nothing is thrown away here.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Account } from "./accounts";
import type { RawSample } from "./model/series";
import { readWindowsRows } from "./windows";

export interface SampleRow {
  ts: number;
  account: string;
  fivePct: number | null;
  fiveResetsAt: number | null;
  weekPct: number | null;
  weekResetsAt: number | null;
  sessionId: string | null;
  source: "statusline";
}

export const dbPath = (a: Account): string => join(a.configDir, "usage.db");

export function openDb(a: Account): Database {
  const db = new Database(dbPath(a), { create: true });
  // WAL + a busy timeout: several sessions on one profile may log at once.
  // The timeout goes first: switching journal_mode takes a lock, and without
  // a timeout already set a concurrent opener fails at once with
  // "database is locked" instead of waiting.
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS samples (
      ts             INTEGER NOT NULL,  -- unix seconds the reading was taken
      account        TEXT    NOT NULL,
      five_pct       REAL,              -- 5-hour window used_percentage
      five_resets_at INTEGER,           -- 5-hour window resets_at (unix seconds)
      week_pct       REAL,              -- 7-day window used_percentage
      week_resets_at INTEGER,           -- 7-day window resets_at (unix seconds)
      session_id     TEXT,
      source         TEXT    NOT NULL DEFAULT 'statusline'
    );
    CREATE INDEX IF NOT EXISTS samples_ts ON samples (ts);
  `);
  return db;
}

export function insertSamples(db: Database, rows: SampleRow[]): void {
  const stmt = db.query(
    `INSERT INTO samples (ts, account, five_pct, five_resets_at, week_pct, week_resets_at, session_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const r of rows) {
      stmt.run(r.ts, r.account, r.fivePct, r.fiveResetsAt, r.weekPct, r.weekResetsAt, r.sessionId, r.source);
    }
  })();
}

/**
 * All readings for an account, oldest first, with runs of identical readings
 * collapsed. A collapsed run still keeps a reading every 30 minutes: the
 * analysis needs to know the account was being watched, not just when it changed.
 *
 * While Windows and Linux are both in use, this merges in the Windows
 * profile's readings (see windows.ts). A row present on both sides (after the
 * cutover import, say) is kept once.
 */
export function readSamples(a: Account): RawSample[] {
  const rows = mergeRows(readLocalRows(a), readWindowsRows(a));
  const out: StoredRow[] = [];
  let last: StoredRow | undefined;
  for (const r of rows) {
    const same = last && r[1] === last[1] && r[2] === last[2] && r[3] === last[3] && r[4] === last[4];
    if (!same || r[0] - last![0] >= 1800) out.push((last = r));
  }
  const tail = rows[rows.length - 1];
  if (tail && out[out.length - 1] !== tail) out.push(tail);
  // Session ids become small numbers: the analysis only needs to tell sessions apart.
  const sids = new Map<string, number>();
  return out.map(([t, f, fr, w, wr, sid]) => {
    if (sid != null && !sids.has(sid)) sids.set(sid, sids.size);
    return [t, f, fr, w, wr, sid == null ? null : sids.get(sid)!];
  });
}

/** A usage.db row as the analysis reads it: RawSample with the session_id still a string. */
export type StoredRow = [number, number | null, number | null, number | null, number | null, string | null];

function readLocalRows(a: Account): StoredRow[] {
  if (!existsSync(dbPath(a))) return [];
  // Read-only: the dashboard renders from several log.ts processes at once,
  // and a reader has no reason to take the schema/journal-mode write locks.
  const db = new Database(dbPath(a), { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    return db
      .query("SELECT ts, five_pct, five_resets_at, week_pct, week_resets_at, session_id FROM samples ORDER BY ts")
      .values() as StoredRow[];
  } finally {
    db.close();
  }
}

/** Two ts-sorted row lists merged into one, dropping rows that are identical in every field. */
export function mergeRows(a: StoredRow[], b: StoredRow[]): StoredRow[] {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const seen = new Set<string>();
  const out: StoredRow[] = [];
  for (const r of [...a, ...b].sort((x, y) => x[0] - y[0])) {
    const key = r.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

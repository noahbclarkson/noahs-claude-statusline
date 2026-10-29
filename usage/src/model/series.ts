// Turns raw status-line samples into clean per-account series:
//   - weekly windows (one per seven_day.resets_at) with a monotonic usage curve
//   - the 5-hour window curve
//   - hourly usage increments (percentage points of the weekly limit per hour)
//
// Raw samples are noisy in one specific way: every open Claude Code session
// reports the rate limits from its *own* last API response, so an idle session
// keeps reporting an old, lower figure while a busy one reports the live one.
// Usage inside one window can only grow, so a running max per window removes
// the stale readings without discarding anything real.

import { HOUR, WEEK, addDays, dayOfWeek, dayStart, hourIndex, hourOfDay, isWeekendDow } from "./time";

/** [ts, five_pct, five_resets_at, week_pct, week_resets_at] as stored in usage.db. */
export type RawSample = [number, number | null, number | null, number | null, number | null];

export interface Point {
  t: number;
  pct: number;
}

export interface WeekWindow {
  start: number;
  end: number;
  /** Cleaned observations (running max), chronological. */
  points: Point[];
}

export interface FivePoint {
  t: number;
  pct: number;
  /** End of the active 5-hour window, or null when none was active. */
  reset: number | null;
}

export interface Day {
  start: number;
  end: number;
  dow: number;
  weekend: boolean;
  /** hourly[] index range [h0, h1) covered by this day. */
  h0: number;
  h1: number;
}

export interface AccountSeries {
  id: string;
  label: string;
  now: number;
  windows: WeekWindow[];
  five: FivePoint[];
  firstObs: number | null;
  lastObs: number | null;
  /** Epoch-hour index of hourly[0]. */
  hour0: number;
  /** Percentage points of the weekly limit used in each hour, hour0 … hour of now. */
  hourly: Float64Array;
  hod: Uint8Array;
  dow: Uint8Array;
  days: Day[];
}

/** Increments seen after a longer silence are spread over the silence. */
const SPREAD_GAP = 3 * HOUR;
/** resets_at is grouped to the nearest 15 minutes to absorb any jitter. */
const RESET_ROUND = 900;

export function buildSeries(id: string, label: string, raw: RawSample[], now: number): AccountSeries {
  const samples = raw.filter((s) => s[0] <= now).sort((a, b) => a[0] - b[0]);
  const windows = buildWindows(samples);
  const five = buildFive(samples);

  const firstObs = windows.length ? windows[0].points[0].t : null;
  const lastObs = samples.length ? samples[samples.length - 1][0] : null;

  const hour0 = hourIndex(firstObs ?? now);
  const len = Math.max(0, hourIndex(now) - hour0 + 1);
  const hourly = new Float64Array(len);
  const hod = new Uint8Array(len);
  const dow = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const t = (hour0 + i) * HOUR;
    hod[i] = hourOfDay(t);
    dow[i] = dayOfWeek(t);
  }

  const add = (t0: number, t1: number, inc: number) => {
    if (inc <= 0) return;
    if (t1 - t0 <= SPREAD_GAP) {
      const i = hourIndex(t1) - hour0;
      if (i >= 0 && i < len) hourly[i] += inc;
      return;
    }
    // Usage that happened while nothing local was watching (claude.ai, another
    // machine) has an unknown timing, so spread it evenly over the silence.
    for (let h = hourIndex(t0); h <= hourIndex(t1); h++) {
      const overlap = Math.min(t1, (h + 1) * HOUR) - Math.max(t0, h * HOUR);
      const i = h - hour0;
      if (overlap > 0 && i >= 0 && i < len) hourly[i] += (inc * overlap) / (t1 - t0);
    }
  };

  let prevT: number | null = null;
  for (const w of windows) {
    // The first window ever observed starts mid-way, so its first reading is a
    // baseline. Every later window starts from 0% at its reset.
    let base: Point | null = prevT == null ? null : { t: Math.max(w.start, prevT), pct: 0 };
    for (const p of w.points) {
      if (base) add(base.t, p.t, p.pct - base.pct);
      base = p;
    }
    prevT = w.points[w.points.length - 1].t;
  }

  const days: Day[] = [];
  if (len > 0) {
    for (let d = dayStart(hour0 * HOUR); d <= now; d = addDays(d, 1)) {
      const end = addDays(d, 1);
      const dw = dayOfWeek(d);
      days.push({
        start: d,
        end,
        dow: dw,
        weekend: isWeekendDow(dw),
        h0: Math.max(0, hourIndex(d) - hour0),
        h1: Math.min(len, hourIndex(end) - hour0),
      });
    }
  }

  return { id, label, now, windows, five, firstObs, lastObs, hour0, hourly, hod, dow, days };
}

function buildWindows(samples: RawSample[]): WeekWindow[] {
  const byEnd = new Map<number, Point[]>();
  for (const [t, , , w, wr] of samples) {
    if (w == null || wr == null) continue;
    // A reset in the past is a session still showing an expired window.
    if (wr <= t || wr - t > WEEK + HOUR) continue;
    const end = Math.round(wr / RESET_ROUND) * RESET_ROUND;
    let pts = byEnd.get(end);
    if (!pts) byEnd.set(end, (pts = []));
    pts.push({ t, pct: w });
  }
  const windows: WeekWindow[] = [...byEnd.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([end, pts]) => {
      let max = 0;
      const points = pts.map((p) => ({ t: p.t, pct: (max = Math.max(max, p.pct)) }));
      return { start: end - WEEK, end, points };
    });
  // If an account's weekly anchor ever moves, windows overlap; the newer one
  // can only start once the older one stops being observed.
  for (let i = 1; i < windows.length; i++) {
    const prev = windows[i - 1].points;
    windows[i].start = Math.max(windows[i].start, prev[prev.length - 1].t);
  }
  return windows;
}

function buildFive(samples: RawSample[]): FivePoint[] {
  const out: FivePoint[] = [];
  const maxBy = new Map<number, number>();
  let active: number | null = null;
  for (const [t, f, fr] of samples) {
    if (f == null) continue;
    if (fr != null && fr > t) {
      const r = Math.round(fr / 60) * 60;
      maxBy.set(r, Math.max(maxBy.get(r) ?? 0, f));
      if (active == null || r > active) active = r;
    }
    // A stale session may report an expired window (or an older one) while
    // another session is inside the live one; the latest window wins.
    const eff = active != null && active > t ? active : null;
    out.push({ t, pct: eff != null ? maxBy.get(eff)! : 0, reset: eff });
  }
  return out;
}

/** Weekly usage at time t (0 inside a window with no readings yet). */
export function pctAt(s: AccountSeries, t: number): number {
  const w = s.windows.find((w) => w.start <= t && t < w.end);
  if (!w) return 0;
  let pct = 0;
  for (const p of w.points) {
    if (p.t > t) break;
    pct = p.pct;
  }
  return pct;
}

export interface CurrentWindow {
  start: number;
  end: number;
  pct: number;
}

/** The weekly window containing t, projected forward from the last known reset. */
export function currentWindow(s: AccountSeries, t: number): CurrentWindow | null {
  const w = s.windows.find((w) => w.start <= t && t < w.end);
  if (w) return { start: w.start, end: w.end, pct: pctAt(s, t) };
  const last = s.windows[s.windows.length - 1];
  if (!last) return null;
  let end = last.end;
  while (end <= t) end += WEEK;
  return { start: end - WEEK, end, pct: 0 };
}

/** Current 5-hour window at t. */
export function currentFive(s: AccountSeries, t: number): { pct: number; reset: number | null } {
  const last = s.five[s.five.length - 1];
  if (!last || last.reset == null || last.reset <= t) return { pct: 0, reset: null };
  return { pct: last.pct, reset: last.reset };
}

export interface DayUsage {
  start: number;
  dow: number;
  weekend: boolean;
  usage: number;
}

/** Complete local days fully inside the observed history, with their usage. */
export function completeDays(s: AccountSeries, asOf = s.now): DayUsage[] {
  if (s.firstObs == null) return [];
  const out: DayUsage[] = [];
  for (const d of s.days) {
    if (d.start < s.firstObs || d.end > asOf) continue;
    let usage = 0;
    for (let i = d.h0; i < d.h1; i++) usage += s.hourly[i];
    out.push({ start: d.start, dow: d.dow, weekend: d.weekend, usage });
  }
  return out;
}

/** Usage per local day for every day overlapping [from, asOf], partial days included. */
export function dailyUsage(s: AccountSeries, from: number, asOf = s.now): DayUsage[] {
  const out: DayUsage[] = [];
  for (const d of s.days) {
    if (d.end <= from || d.start > asOf) continue;
    let usage = 0;
    const hEnd = Math.min(d.h1, hourIndex(asOf) - s.hour0 + 1);
    for (let i = d.h0; i < hEnd; i++) usage += s.hourly[i];
    out.push({ start: d.start, dow: d.dow, weekend: d.weekend, usage });
  }
  return out;
}


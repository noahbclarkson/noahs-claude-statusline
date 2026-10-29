// Forecast models. Every model answers one question — "how many percentage
// points of the weekly limit will this account use on local day d?" — and the
// learned time-of-day shape spreads that day over its hours. Weekends are always
// weekday-equivalent usage × (1 − weekendReduction), so the weekend setting
// means the same thing in every model.

import { type AccountSeries, type Point, currentWindow } from "./series";
import {
  DAY,
  HOUR,
  WEEK,
  addDays,
  clamp,
  dayOfWeek,
  dayStart,
  hourIndex,
  hourOfDay,
  isWeekend,
  isWeekendDow,
} from "./time";

export type ModelId = "blend" | "flat" | "recent" | "seasonal" | "trend" | "holt";

export const MODELS: { id: ModelId; label: string; blurb: string }[] = [
  { id: "blend", label: "Blend", blurb: "Average of every model below that has enough data. Usually the steadiest." },
  { id: "flat", label: "Flat pace", blurb: "Average pace since the reset (and prior weeks, if included), carried forward unchanged." },
  { id: "recent", label: "Recent pace", blurb: "Pace over the last few days only, carried forward. Reacts fastest to a change in habits." },
  { id: "seasonal", label: "Weekday pattern", blurb: "Each weekday's typical usage from past weeks, scaled to how this week is tracking so far." },
  { id: "trend", label: "Linear trend", blurb: "A straight line through daily weekday usage, extended forward. Picks up steady growth or decline." },
  { id: "holt", label: "Smoothed trend", blurb: "Holt–Winters: exponentially smoothed level plus a damped trend, with a weekday profile." },
];

export const modelLabel = (id: ModelId): string => MODELS.find((m) => m.id === id)?.label ?? id;

export interface ModelConfig {
  includePriorWeeks: boolean;
  priorWeeks: number;
  /** Recency weighting: a week this many weeks old counts half. 0 = equal weights. */
  halfLifeWeeks: number;
  /** 0..1 — weekend days use this much less than weekdays. */
  weekendReduction: number;
  shape: "learned" | "uniform";
  recentDays: number;
  /** Weekday pattern: scale the profile to this week's actual pace. */
  adaptLevel: boolean;
  alpha: number;
  beta: number;
  phi: number;
  weekdayProfile: boolean;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  includePriorWeeks: true,
  priorWeeks: 4,
  halfLifeWeeks: 2,
  weekendReduction: 0.8,
  shape: "learned",
  recentDays: 2,
  adaptLevel: true,
  alpha: 0.3,
  beta: 0.1,
  phi: 0.9,
  weekdayProfile: true,
};

export interface Forecast {
  id: ModelId;
  ok: boolean;
  note?: string;
  /** Expected usage (pp) for the whole local day starting at `day`. */
  daily(day: number): number;
}

interface DayStat {
  start: number;
  dow: number;
  weekend: boolean;
  usage: number;
  w: number;
}

export interface Ctx {
  s: AccountSeries;
  asOf: number;
  cfg: ModelConfig;
  /** hourly[] entries before this index are complete as of asOf. */
  hEnd: number;
  winStart: number;
  winEnd: number;
  pctNow: number;
  /** Start of the history the level-setting models may use. */
  lookStart: number;
  /** Time-of-day shape, [weekday, weekend]; each sums to 1 over the 24 hours. */
  shape: [Float64Array, Float64Array];
  /** Complete days inside the lookback, with recency weights. */
  days: DayStat[];
  weight(t: number): number;
}

/** The time-of-day shape always looks back this far; it describes habit, not level. */
const SHAPE_WEEKS = 8;

export function makeCtx(s: AccountSeries, asOf: number, cfg: ModelConfig): Ctx {
  const cw = currentWindow(s, asOf);
  const winStart = cw?.start ?? asOf;
  const winEnd = cw?.end ?? asOf + WEEK;
  const first = s.firstObs ?? asOf;
  const lookStart = Math.max(first, cfg.includePriorWeeks ? winStart - cfg.priorWeeks * WEEK : winStart);
  const hEnd = clamp(hourIndex(asOf) - s.hour0, 0, s.hourly.length);
  const hl = cfg.halfLifeWeeks;
  const weight = (t: number) => (hl > 0 ? 0.5 ** ((asOf - t) / WEEK / hl) : 1);

  const days: DayStat[] = [];
  const lookDay = dayStart(lookStart);
  for (const d of s.days) {
    if (d.start < first || d.start < lookDay || d.end > asOf) continue;
    let usage = 0;
    for (let i = d.h0; i < d.h1; i++) usage += s.hourly[i];
    days.push({ start: d.start, dow: d.dow, weekend: d.weekend, usage, w: weight(d.start + DAY / 2) });
  }

  return {
    s,
    asOf,
    cfg,
    hEnd,
    winStart,
    winEnd,
    pctNow: cw?.pct ?? 0,
    lookStart,
    shape: cfg.shape === "uniform" ? uniformShape() : learnShape(s, asOf, hEnd, weight),
    days,
    weight,
  };
}

function uniformShape(): [Float64Array, Float64Array] {
  const u = new Float64Array(24).fill(1 / 24);
  return [u, u];
}

function learnShape(s: AccountSeries, asOf: number, hEnd: number, weight: (t: number) => number): [Float64Array, Float64Array] {
  const acc = [new Float64Array(24), new Float64Array(24)];
  const tot = [0, 0];
  for (let i = Math.max(0, hourIndex(asOf - SHAPE_WEEKS * WEEK) - s.hour0); i < hEnd; i++) {
    const u = s.hourly[i];
    if (u <= 0) continue;
    const k = isWeekendDow(s.dow[i]) ? 1 : 0;
    const w = u * weight((s.hour0 + i) * HOUR);
    acc[k][s.hod[i]] += w;
    tot[k] += w;
  }
  // A small uniform prior keeps quiet hours from being forecast as exactly zero.
  const norm = (a: Float64Array, total: number) => {
    const prior = Math.max(0.5, 0.05 * total);
    return a.map((v) => (v + prior / 24) / (total + prior));
  };
  const wd = norm(acc[0], tot[0]);
  return [wd, tot[1] >= 3 ? norm(acc[1], tot[1]) : wd];
}

export const shapeAt = (ctx: Ctx, t: number): number => ctx.shape[isWeekend(t) ? 1 : 0][hourOfDay(t)];
const wk = (ctx: Ctx, dow: number): number => (isWeekendDow(dow) ? 1 - ctx.cfg.weekendReduction : 1);

function mk(id: ModelId, daily: (day: number) => number, note?: string): Forecast {
  const memo = new Map<number, number>();
  return {
    id,
    ok: true,
    note,
    daily(day) {
      let v = memo.get(day);
      if (v === undefined) memo.set(day, (v = daily(day)));
      return v;
    },
  };
}

const fail = (id: ModelId, note: string): Forecast => ({ id, ok: false, note, daily: () => 0 });

/** Usage per weekday-equivalent day over the hours from `from` to asOf. */
function pace(ctx: Ctx, from: number, weighted: boolean): { base: number; den: number } {
  const { s, hEnd } = ctx;
  let num = 0;
  let den = 0;
  for (let i = Math.max(0, hourIndex(from) - s.hour0); i < hEnd; i++) {
    const t = (s.hour0 + i) * HOUR;
    const w = weighted ? ctx.weight(t) : 1;
    const we = isWeekendDow(s.dow[i]);
    num += w * s.hourly[i];
    den += w * (we ? 1 - ctx.cfg.weekendReduction : 1) * ctx.shape[we ? 1 : 0][s.hod[i]];
  }
  return { base: den > 0 ? num / den : 0, den };
}

const MIN_DAYS = 0.25;

function flat(ctx: Ctx): Forecast {
  let { base, den } = pace(ctx, ctx.lookStart, true);
  let note: string | undefined;
  if (den < MIN_DAYS) {
    const all = pace(ctx, ctx.s.firstObs ?? ctx.asOf, true);
    if (all.den < MIN_DAYS) return fail("flat", "Not enough history yet.");
    ({ base } = all);
    note = "Too little data since the reset, so this uses all history.";
  }
  return mk("flat", (d) => base * wk(ctx, dayOfWeek(d)), note);
}

function recent(ctx: Ctx): Forecast {
  const { base, den } = pace(ctx, ctx.asOf - ctx.cfg.recentDays * DAY, false);
  if (den < MIN_DAYS) return fail("recent", `No usable data in the last ${ctx.cfg.recentDays} days.`);
  return mk("recent", (d) => base * wk(ctx, dayOfWeek(d)));
}

function seasonal(ctx: Ctx): Forecast {
  const acc = new Float64Array(7);
  const ws = new Float64Array(7);
  for (const d of ctx.days) {
    if (d.weekend) continue;
    acc[d.dow] += d.w * d.usage;
    ws[d.dow] += d.w;
  }
  const S = new Float64Array(7);
  let sum = 0;
  let n = 0;
  for (let dw = 1; dw <= 5; dw++) {
    if (ws[dw] <= 0) continue;
    S[dw] = acc[dw] / ws[dw];
    sum += S[dw];
    n++;
  }
  if (n < 3) return fail("seasonal", "Needs at least three different weekdays of history. Include prior weeks.");
  const mean = sum / n;
  for (let dw = 1; dw <= 5; dw++) if (ws[dw] <= 0) S[dw] = mean;
  S[0] = S[6] = mean * (1 - ctx.cfg.weekendReduction);

  let level = 1;
  let note: string | undefined;
  if (ctx.cfg.adaptLevel) {
    const { s } = ctx;
    const from = Math.max(ctx.winStart, s.firstObs ?? ctx.asOf);
    let expected = 0;
    let actual = 0;
    for (let i = Math.max(0, hourIndex(from) - s.hour0); i < ctx.hEnd; i++) {
      expected += S[s.dow[i]] * ctx.shape[isWeekendDow(s.dow[i]) ? 1 : 0][s.hod[i]];
      actual += s.hourly[i];
    }
    if (expected > 0.5) {
      const confidence = clamp((ctx.asOf - from) / (3 * DAY), 0, 1);
      level = 1 + confidence * (clamp(actual / expected, 0.25, 4) - 1);
      note = `This week is running at ${Math.round((actual / expected) * 100)}% of the usual pattern.`;
    }
  }
  return mk("seasonal", (d) => S[dayOfWeek(d)] * level, note);
}

function trend(ctx: Ctx): Forecast {
  const today = dayStart(ctx.asOf);
  const pts = ctx.days.filter((d) => !d.weekend).map((d) => ({ x: (d.start - today) / DAY, y: d.usage, w: d.w }));
  if (pts.length < 4) return fail("trend", "Needs at least four complete weekdays.");
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sw += p.w;
    sx += p.w * p.x;
    sy += p.w * p.y;
  }
  const mx = sx / sw;
  const my = sy / sw;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += p.w * (p.x - mx) ** 2;
    sxy += p.w * (p.x - mx) * (p.y - my);
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  const a = my - b * mx;
  // A straight line can run away over a long horizon; keep it within 3× the
  // busiest day seen.
  const cap = Math.max(1, 3 * Math.max(...pts.map((p) => p.y)));
  const perWeek = b * 7;
  const note = `Weekday usage is ${perWeek >= 0 ? "rising" : "falling"} by ${Math.abs(perWeek).toFixed(1)} pp/day each week.`;
  return mk("trend", (d) => clamp(a + b * ((d - today) / DAY), 0, cap) * wk(ctx, dayOfWeek(d)), note);
}

function holt(ctx: Ctx): Forecast {
  const { alpha, beta, phi } = ctx.cfg;
  const series = ctx.days.filter((d) => !d.weekend);
  if (series.length < 5) return fail("holt", "Needs at least five complete weekdays.");

  const idx = new Float64Array(7).fill(1);
  if (ctx.cfg.weekdayProfile) {
    const acc = new Float64Array(7);
    const ws = new Float64Array(7);
    const cnt = new Float64Array(7);
    let tot = 0;
    let wTot = 0;
    for (const d of series) {
      acc[d.dow] += d.w * d.usage;
      ws[d.dow] += d.w;
      cnt[d.dow]++;
      tot += d.w * d.usage;
      wTot += d.w;
    }
    const m = tot / wTot;
    // Shrink each weekday's index towards 1 with two pseudo-weeks of evidence.
    if (m > 0) for (let dw = 1; dw <= 5; dw++) if (ws[dw] > 0) idx[dw] = (cnt[dw] * (acc[dw] / ws[dw] / m) + 2) / (cnt[dw] + 2);
  }

  const y = series.map((d) => d.usage / idx[d.dow]);
  const init = y.slice(0, Math.min(5, y.length));
  let L = init.reduce((a, b) => a + b, 0) / init.length;
  let T = 0;
  for (const v of y) {
    const prev = L;
    L = alpha * v + (1 - alpha) * (L + phi * T);
    T = beta * (L - prev) + (1 - beta) * phi * T;
  }
  const lastDay = series[series.length - 1].start;
  return mk("holt", (d) => {
    let k = 0;
    for (let x = addDays(lastDay, 1); x <= d; x = addDays(x, 1)) if (!isWeekendDow(dayOfWeek(x))) k++;
    k = Math.max(1, k);
    let f = L;
    let p = 1;
    for (let i = 1; i <= k; i++) {
      p *= phi;
      f += p * T;
    }
    const dw = dayOfWeek(d);
    return Math.max(0, f) * (isWeekendDow(dw) ? 1 - ctx.cfg.weekendReduction : idx[dw]);
  });
}

export type ForecastSet = Record<ModelId, Forecast>;

export function forecastAll(ctx: Ctx): ForecastSet {
  const parts = [flat(ctx), recent(ctx), seasonal(ctx), trend(ctx), holt(ctx)];
  const ok = parts.filter((f) => f.ok);
  const blend = ok.length
    ? mk("blend", (d) => ok.reduce((sum, f) => sum + f.daily(d), 0) / ok.length, `Averages ${ok.map((f) => modelLabel(f.id)).join(", ")}.`)
    : fail("blend", "Not enough history yet.");
  const set = { blend } as ForecastSet;
  for (const f of parts) set[f.id] = f;
  return set;
}

/** The chosen model, or Blend when it lacks the data it needs. */
export function choose(set: ForecastSet, id: ModelId): Forecast {
  const f = set[id];
  if (f.ok || id === "blend") return f;
  return { ...set.blend, note: `${modelLabel(id)} can't run here (${f.note}) Showing Blend instead.` };
}

/** Forecast usage rate (pp per hour) during the hour containing t. */
export const rateAt = (ctx: Ctx, f: Forecast, t: number): number => f.daily(dayStart(t)) * shapeAt(ctx, t);

/** Sum of fn over [from, to), hour by hour, with partial first and last hours. */
function integrate(from: number, to: number, fn: (t: number) => number): number {
  let sum = 0;
  for (let t = from; t < to; ) {
    const next = Math.min((hourIndex(t) + 1) * HOUR, to);
    sum += (fn(t) * (next - t)) / HOUR;
    t = next;
  }
  return sum;
}

export const demand = (ctx: Ctx, f: Forecast, from: number, to: number): number => integrate(from, to, (t) => rateAt(ctx, f, t));

/** Remaining time, counted in weekday-equivalent days of usage. */
export const weightedDays = (ctx: Ctx, from: number, to: number): number =>
  integrate(from, to, (t) => (isWeekend(t) ? 1 - ctx.cfg.weekendReduction : 1) * shapeAt(ctx, t));

export interface Projection {
  points: Point[];
  /** Projected usage just before the current window resets. */
  atReset: number;
  hitTarget: number | null;
  hit100: number | null;
  demandToReset: number;
}

/** Hourly projection from asOf to `until` (at least the current reset), resetting to 0 at each reset. */
export function project(ctx: Ctx, f: Forecast, until: number, target: number): Projection {
  let pct = ctx.pctNow;
  let end = ctx.winEnd;
  let t = ctx.asOf;
  let first = true;
  const stopAt = Math.max(until, end);
  const points: Point[] = [{ t, pct }];
  let atReset = pct;
  let hitTarget: number | null = null;
  let hit100: number | null = null;
  let demandToReset = 0;
  const crossing = (t0: number, t1: number, p0: number, p1: number, level: number) =>
    t0 + ((level - p0) / (p1 - p0)) * (t1 - t0);

  while (t < stopAt) {
    const next = Math.min((hourIndex(t) + 1) * HOUR, stopAt, end);
    const inc = (rateAt(ctx, f, t) * (next - t)) / HOUR;
    const p0 = pct;
    pct += inc;
    if (first) {
      demandToReset += inc;
      if (hitTarget == null && p0 < target && pct >= target) hitTarget = crossing(t, next, p0, pct, target);
      if (hit100 == null && p0 < 100 && pct >= 100) hit100 = crossing(t, next, p0, pct, 100);
    }
    t = next;
    points.push({ t, pct });
    if (t >= end) {
      if (first) atReset = pct;
      first = false;
      pct = 0;
      end += WEEK;
      if (t < stopAt) points.push({ t, pct }); // no trailing drop when the projection ends at a reset
    }
  }
  return { points, atReset, hitTarget, hit100, demandToReset };
}

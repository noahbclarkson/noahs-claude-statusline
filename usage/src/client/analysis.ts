// Everything the views show, computed from the series and the current settings.

import { type BacktestScore, backtest } from "../model/backtest";
import {
  type Ctx,
  type Forecast,
  type ForecastSet,
  type ModelConfig,
  type ModelId,
  type Projection,
  MODELS,
  choose,
  forecastAll,
  makeCtx,
  project,
  rateAt,
  weightedDays,
} from "../model/forecast";
import { type AccountSeries, type CurrentWindow, type DayUsage, completeDays, currentFive, currentWindow } from "../model/series";
import { type SimAccount, type SimResult, maxMultiplier, simulate } from "../model/simulate";
import { DAY, dayStart } from "../model/time";
import { type WeekendStats, sumDays, weekendStats } from "../model/weekend";
import { type Settings, modelConfig } from "./settings";

export interface AccountView {
  id: string;
  label: string;
  color: string;
  s: AccountSeries;
  has: boolean;
  weekend: { stats: WeekendStats; applied: number; source: "manual" | "learned" | "override" };
  cfg: ModelConfig;
  ctx: Ctx;
  set: ForecastSet;
  chosen: Forecast;
  cw: CurrentWindow | null;
  five: { pct: number; reset: number | null };
  until: number;
  proj: Projection | null;
  projBy: Partial<Record<ModelId, Projection>>;
  band: { x: number; lo: number; hi: number }[];
  pace: { budgetPerWeekday: number; forecastPerWeekday: number; mult: number } | null;
}

export interface Combined {
  members: AccountView[];
  until: number;
  sim: SimResult | null;
  mult: number;
  /** Simulated (after sharing) usage per account per future local day. */
  simDaily: Record<string, Map<number, number>>;
  weekend: WeekendStats;
}

export interface Analysis {
  now: number;
  accounts: AccountView[];
  combined: Combined;
}

/** Weekend stats look back further than the models: they describe a habit. */
const WEEKEND_HALF_LIFE = 4;

export function analyse(series: AccountSeries[], st: Settings, now: number): Analysis {
  const accounts = series.map((s, i) => view(s, i, st, now));
  return { now, accounts, combined: combine(accounts, st, now) };
}

function view(s: AccountSeries, index: number, st: Settings, now: number): AccountView {
  const stats = weekendStats(completeDays(s, now), now, WEEKEND_HALF_LIFE);
  const override = st.weekendOverride[s.id];
  const weekend =
    override != null
      ? { stats, applied: override / 100, source: "override" as const }
      : st.weekendMode === "learned" && stats.reduction != null
        ? { stats, applied: stats.reduction, source: "learned" as const }
        : { stats, applied: st.weekendReduction / 100, source: "manual" as const };
  const cfg = modelConfig(st, weekend.applied);
  const ctx = makeCtx(s, now, cfg);
  const set = forecastAll(ctx);
  const chosen = choose(set, st.model);
  const cw = currentWindow(s, now);
  const has = s.windows.length > 0;
  const until = cw ? (st.horizon > 0 ? Math.max(cw.end, now + st.horizon * DAY) : cw.end) : now;

  const projBy: Partial<Record<ModelId, Projection>> = {};
  let proj: Projection | null = null;
  let band: AccountView["band"] = [];
  let pace: AccountView["pace"] = null;
  if (has && cw && chosen.ok) {
    proj = project(ctx, chosen, until, st.target);
    for (const m of MODELS) if (set[m.id].ok) projBy[m.id] = project(ctx, set[m.id], until, st.target);
    const all = Object.values(projBy);
    band = proj.points.map((p, i) => {
      const vs = all.map((pr) => pr.points[i]?.pct ?? p.pct);
      return { x: p.t, lo: Math.min(...vs), hi: Math.max(...vs) };
    });
    const room = Math.max(0, st.target - cw.pct);
    const days = weightedDays(ctx, now, cw.end);
    pace = {
      budgetPerWeekday: days > 0 ? room / days : 0,
      forecastPerWeekday: days > 0 ? proj.demandToReset / days : 0,
      mult: proj.demandToReset > 1e-6 ? room / proj.demandToReset : Infinity,
    };
  }

  return {
    id: s.id,
    label: s.label,
    color: `var(--series-${index + 1})`,
    s,
    has,
    weekend,
    cfg,
    ctx,
    set,
    chosen,
    cw,
    five: currentFive(s, now),
    until,
    proj,
    projBy,
    band,
    pace,
  };
}

function combine(accounts: AccountView[], st: Settings, now: number): Combined {
  const members = accounts.filter((a) => a.has && a.cw && a.chosen.ok);
  const cap = (id: string) => st.capacity[id] || 1;
  const until = st.horizon > 0 ? now + st.horizon * DAY : Math.max(now + DAY, ...members.map((a) => a.cw!.end));
  const inputs: SimAccount[] = members.map((a) => ({
    id: a.id,
    pct0: a.cw!.pct,
    end0: a.cw!.end,
    capacity: cap(a.id),
    rate: (t) => rateAt(a.ctx, a.chosen, t),
  }));
  const sim = members.length ? simulate(inputs, now, until, st.target) : null;
  const mult = members.length ? maxMultiplier(inputs, now, until, st.target) : NaN;

  const simDaily: Record<string, Map<number, number>> = {};
  if (sim) {
    for (const a of members) {
      const m = new Map<number, number>();
      const pts = sim.points[a.id];
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1];
        const p1 = pts[i];
        if (p1.t <= p0.t || p1.pct < p0.pct) continue; // a reset
        const d = dayStart(p0.t);
        m.set(d, (m.get(d) ?? 0) + p1.pct - p0.pct);
      }
      simDaily[a.id] = m;
    }
  }

  const days: DayUsage[] = sumDays(accounts.filter((a) => a.has).map((a) => ({ days: completeDays(a.s, now), scale: cap(a.id) })));
  return { members, until, sim, mult, simDaily, weekend: weekendStats(days, now, WEEKEND_HALF_LIFE) };
}

const btCache = new Map<string, Record<ModelId, BacktestScore>>();

/** Backtests are the slowest thing here, so they run only for the account on screen. */
export function backtestFor(a: AccountView): Record<ModelId, BacktestScore> {
  const key = `${a.id}:${a.s.now}:${JSON.stringify(a.cfg)}`;
  let r = btCache.get(key);
  if (!r) btCache.set(key, (r = backtest(a.s, a.cfg)));
  return r;
}

// Historical weekday vs weekend usage, and the weekend reduction it implies.

import type { DayUsage } from "./series";
import { WEEK, addDays, clamp, mondayOf } from "./time";

export interface WeekendWeek {
  /** Local Monday 00:00. */
  start: number;
  /** Average pp per weekday (Mon–Fri). */
  weekday: number;
  /** Average pp per weekend day (Sat–Sun). */
  weekend: number;
}

export interface WeekendStats {
  weeks: WeekendWeek[];
  weekdayAvg: number;
  weekendAvg: number;
  /** 1 − weekend/weekday, recency weighted; null without enough weekday usage. */
  reduction: number | null;
}

/** Full Monday–Sunday weeks only, so every weekend is compared with its own week. */
export function weekendStats(days: DayUsage[], asOf: number, halfLifeWeeks = 4, maxWeeks = 12): WeekendStats {
  const byWeek = new Map<number, DayUsage[]>();
  for (const d of days) {
    const m = mondayOf(d.start);
    let list = byWeek.get(m);
    if (!list) byWeek.set(m, (list = []));
    list.push(d);
  }
  const weeks: WeekendWeek[] = [...byWeek.entries()]
    .filter(([m, list]) => list.length === 7 && addDays(m, 7) <= asOf)
    .sort((a, b) => a[0] - b[0])
    .slice(-maxWeeks)
    .map(([start, list]) => {
      let wd = 0;
      let we = 0;
      for (const d of list) d.weekend ? (we += d.usage) : (wd += d.usage);
      return { start, weekday: wd / 5, weekend: we / 2 };
    });

  let sw = 0;
  let wd = 0;
  let we = 0;
  for (const w of weeks) {
    const weight = halfLifeWeeks > 0 ? 0.5 ** ((asOf - (w.start + WEEK)) / WEEK / halfLifeWeeks) : 1;
    sw += weight;
    wd += weight * w.weekday;
    we += weight * w.weekend;
  }
  const weekdayAvg = sw > 0 ? wd / sw : 0;
  const weekendAvg = sw > 0 ? we / sw : 0;
  return {
    weeks,
    weekdayAvg,
    weekendAvg,
    reduction: weekdayAvg > 0.25 ? clamp(1 - weekendAvg / weekdayAvg, 0, 1) : null,
  };
}

/** Day-by-day sum of several accounts, each scaled (by plan capacity). */
export function sumDays(lists: { days: DayUsage[]; scale: number }[]): DayUsage[] {
  const out = new Map<number, DayUsage>();
  for (const { days, scale } of lists) {
    for (const d of days) {
      const cur = out.get(d.start);
      if (cur) cur.usage += d.usage * scale;
      else out.set(d.start, { ...d, usage: d.usage * scale });
    }
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}

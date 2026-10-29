import { describe, expect, test } from "bun:test";
import { backtest } from "../src/model/backtest";
import { DEFAULT_MODEL_CONFIG, type ModelConfig, demand, forecastAll, makeCtx, project } from "../src/model/forecast";
import { type RawSample, buildSeries, completeDays, currentFive, currentWindow, pctAt } from "../src/model/series";
import { maxMultiplier, simulate } from "../src/model/simulate";
import { HOUR, WEEK, addDays, dayOfWeek, isWeekendDow } from "../src/model/time";
import { weekendStats } from "../src/model/weekend";

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime() / 1000;

/**
 * Synthetic account: weekly reset on Tuesdays 06:00, readings every 5 minutes
 * from 09:00 to 17:00, using `wdRate` pp/hour on weekdays and `weRate` at weekends.
 */
function synth(weeks: number, wdRate = 2, weRate = 0.4, firstReset = local(2026, 6, 2, 6)) {
  const raw: RawSample[] = [];
  const endAll = firstReset + weeks * WEEK;
  let reset = firstReset + WEEK;
  let used = 0;
  for (let day = local(2026, 6, 2); day < endAll; day = addDays(day, 1)) {
    const weekend = isWeekendDow(dayOfWeek(day));
    for (let t = day + 9 * HOUR; t < day + 17 * HOUR; t += 300) {
      if (t < firstReset) continue;
      if (t >= reset) {
        reset += WEEK;
        used = 0;
      }
      used += ((weekend ? weRate : wdRate) * 300) / HOUR;
      raw.push([t, 10, t + 2 * HOUR, Math.round(used * 100) / 100, reset]);
    }
  }
  return { raw, end: endAll };
}

describe("series cleaning", () => {
  test("a stale session's lower reading never pulls usage down", () => {
    const r = local(2026, 6, 9, 6);
    const raw: RawSample[] = [
      [r - 3 * 86400, null, null, 10, r],
      [r - 3 * 86400 + 300, null, null, 20, r],
      [r - 3 * 86400 + 600, null, null, 12, r], // idle session, old figure
      [r - 3 * 86400 + 900, null, null, 21, r],
    ];
    const s = buildSeries("a", "A", raw, r - 2 * 86400);
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0].points.map((p) => p.pct)).toEqual([10, 20, 20, 21]);
    expect(pctAt(s, r - 3 * 86400 + 650)).toBe(20);
  });

  test("readings of an expired window are ignored and the next reset is inferred", () => {
    const r = local(2026, 6, 9, 6);
    const raw: RawSample[] = [
      [r - 3600, 5, r - 1800, 50, r],
      [r + 3600, 5, r - 1800, 50, r], // still showing last week's window
    ];
    const s = buildSeries("a", "A", raw, r + 7200);
    const cw = currentWindow(s, r + 7200)!;
    expect(cw.end).toBe(r + WEEK);
    expect(cw.pct).toBe(0);
    expect(currentFive(s, r + 7200).pct).toBe(0);
  });

  test("usage after a short gap lands in its hour; after a long gap it is spread", () => {
    const r = local(2026, 6, 16, 6);
    const t0 = r - 4 * 86400;
    const raw: RawSample[] = [
      [t0, null, null, 10, r],
      [t0 + HOUR, null, null, 12, r], // +2 in one hour
      [t0 + 11 * HOUR, null, null, 22, r], // +10 over a 10-hour silence
    ];
    const s = buildSeries("a", "A", raw, t0 + 12 * HOUR);
    const i = (t: number) => Math.floor(t / HOUR) - s.hour0;
    expect(s.hourly[i(t0 + HOUR)]).toBeCloseTo(2 + 1, 6); // its own +2 plus the first tenth of the spread
    expect(s.hourly[i(t0 + 5 * HOUR)]).toBeCloseTo(1, 6);
    expect(s.hourly.reduce((a, b) => a + b, 0)).toBeCloseTo(12, 6);
  });

  test("hourly usage reproduces each window's total", () => {
    const { raw, end } = synth(3);
    const s = buildSeries("a", "A", raw, end);
    // Every window after the first starts from zero, so its usage is its final figure.
    const total = s.hourly.reduce((a, b) => a + b, 0);
    const finals = s.windows.slice(1).reduce((a, w) => a + w.points[w.points.length - 1].pct, 0);
    const firstGain = s.windows[0].points.at(-1)!.pct - s.windows[0].points[0].pct;
    expect(total).toBeCloseTo(finals + firstGain, 0);
  });
});

describe("forecasts", () => {
  const { raw, end } = synth(5);
  const s = buildSeries("a", "A", raw, end);
  const asOf = s.windows[s.windows.length - 1].start + 2 * 86400 + 12 * HOUR; // Thursday 18:00

  test("flat pace learns 16 pp per weekday and the weekend reduction scales weekends", () => {
    const cfg: ModelConfig = { ...DEFAULT_MODEL_CONFIG, weekendReduction: 0.8 };
    const ctx = makeCtx(s, asOf, cfg);
    const f = forecastAll(ctx).flat;
    const sat = local(2026, 7, 4);
    const fri = local(2026, 7, 3);
    expect(f.daily(fri)).toBeCloseTo(16, 0);
    expect(f.daily(sat)).toBeCloseTo(16 * 0.2, 0);
  });

  test("every model lands near the true 87.2% at reset on a perfectly regular account", () => {
    const ctx = makeCtx(s, asOf, DEFAULT_MODEL_CONFIG);
    const set = forecastAll(ctx);
    // 5 weekdays × 16 + 2 weekend days × 3.2 = 86.4, plus Tuesday's 06:00–17:00 share.
    const truth = s.windows.slice(1, -1).map((w) => w.points.at(-1)!.pct);
    for (const id of ["flat", "recent", "seasonal", "trend", "holt", "blend"] as const) {
      const p = project(ctx, set[id], ctx.winEnd, 95);
      expect(set[id].ok).toBe(true);
      expect(Math.abs(p.atReset - truth[0])).toBeLessThan(4);
    }
  });

  test("projection reports when the target is crossed", () => {
    const ctx = makeCtx(s, asOf, DEFAULT_MODEL_CONFIG);
    const f = forecastAll(ctx).flat;
    const p = project(ctx, f, ctx.winEnd, 50);
    expect(p.hitTarget).not.toBeNull();
    expect(p.hitTarget!).toBeGreaterThan(asOf);
    expect(p.atReset).toBeCloseTo(ctx.pctNow + demand(ctx, f, asOf, ctx.winEnd), 6);
  });

  test("without prior weeks, the weekday pattern says it needs them", () => {
    const early = s.windows[s.windows.length - 1].start + 86400;
    const ctx = makeCtx(s, early, { ...DEFAULT_MODEL_CONFIG, includePriorWeeks: false });
    expect(forecastAll(ctx).seasonal.ok).toBe(false);
  });

  test("backtest errors are small on a regular account", () => {
    const bt = backtest(s, DEFAULT_MODEL_CONFIG);
    expect(bt.flat.n).toBeGreaterThan(10);
    expect(bt.flat.mae).toBeLessThan(5);
  });
});

describe("weekend stats", () => {
  test("recommends the reduction the data shows", () => {
    const { raw, end } = synth(5, 2, 0.5);
    const s = buildSeries("a", "A", raw, end);
    const ws = weekendStats(completeDays(s), end);
    expect(ws.weeks.length).toBeGreaterThanOrEqual(3);
    expect(ws.reduction!).toBeCloseTo(0.75, 2);
  });
});

describe("redistribution", () => {
  const t0 = local(2026, 6, 1, 0);
  const flatRate = (ppPerHour: number) => () => ppPerHour;

  test("overflow from a capped account is split evenly across the others", () => {
    const r = simulate(
      [
        { id: "a", pct0: 90, end0: t0 + WEEK, capacity: 1, rate: flatRate(1) },
        { id: "b", pct0: 0, end0: t0 + WEEK, capacity: 1, rate: flatRate(0) },
        { id: "c", pct0: 0, end0: t0 + WEEK, capacity: 1, rate: flatRate(0) },
      ],
      t0,
      t0 + 25 * HOUR,
      95,
    );
    expect(r.atReset.a).toBeCloseTo(95, 6);
    expect(r.given.a).toBeCloseTo(20, 6);
    expect(r.received.b).toBeCloseTo(10, 6);
    expect(r.received.c).toBeCloseTo(10, 6);
    expect(r.hitCap.a).toBe(t0 + 5 * HOUR);
    expect(r.unmet).toBe(0);
  });

  test("plan capacity converts overflow between accounts", () => {
    const r = simulate(
      [
        { id: "big", pct0: 95, end0: t0 + WEEK, capacity: 4, rate: flatRate(1) },
        { id: "small", pct0: 0, end0: t0 + WEEK, capacity: 1, rate: flatRate(0) },
      ],
      t0,
      t0 + 10 * HOUR,
      95,
    );
    // 10 pp of a 4× plan is 40 pp of a 1× plan.
    expect(r.received.small).toBeCloseTo(40, 6);
  });

  test("demand that fits nowhere is unmet, and an account resets to zero", () => {
    const r = simulate(
      [
        { id: "a", pct0: 94, end0: t0 + 10 * HOUR, capacity: 1, rate: flatRate(1) },
        { id: "b", pct0: 95, end0: t0 + WEEK, capacity: 1, rate: flatRate(1) },
      ],
      t0,
      t0 + 12 * HOUR,
      95,
    );
    expect(r.atReset.a).toBeCloseTo(95, 6);
    expect(r.unmet).toBeGreaterThan(0);
    expect(r.points.a[r.points.a.length - 1].pct).toBeGreaterThan(0); // refilling after its reset
  });

  test("the multiplier is the most demand that still fits", () => {
    const accts = [
      { id: "a", pct0: 0, end0: t0 + 100 * HOUR, capacity: 1, rate: flatRate(0.5) },
      { id: "b", pct0: 0, end0: t0 + 100 * HOUR, capacity: 1, rate: flatRate(0.5) },
    ];
    // 100 h × 1 pp/h of demand against 190 pp of room → 1.9×.
    expect(maxMultiplier(accts, t0, t0 + 100 * HOUR, 95)).toBeCloseTo(1.9, 2);
  });
});

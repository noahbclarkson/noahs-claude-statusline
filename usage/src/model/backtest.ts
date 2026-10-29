// Backtest: replay every finished weekly window, stop the clock 1–6 days after
// its reset, forecast where it would finish using only the data available then,
// and compare with where it actually finished.

import { type ModelConfig, type ModelId, MODELS, demand, forecastAll, makeCtx } from "./forecast";
import { type AccountSeries, pctAt } from "./series";
import { DAY } from "./time";

export interface BacktestScore {
  /** Mean absolute error at reset, pp. */
  mae: number;
  /** Mean signed error at reset, pp (positive = forecast too high). */
  bias: number;
  n: number;
}

export function backtest(s: AccountSeries, cfg: ModelConfig, checkpoints = [1, 2, 3, 4, 5, 6]): Record<ModelId, BacktestScore> {
  const errs = Object.fromEntries(MODELS.map((m) => [m.id, [] as number[]])) as Record<ModelId, number[]>;
  for (const w of s.windows) {
    if (s.firstObs == null || w.start < s.firstObs || w.end > s.now) continue;
    const actual = w.points[w.points.length - 1].pct;
    for (const k of checkpoints) {
      const t = w.start + k * DAY;
      const ctx = makeCtx(s, t, cfg);
      const set = forecastAll(ctx);
      const now = pctAt(s, t);
      for (const m of MODELS) {
        const f = set[m.id];
        if (!f.ok) continue;
        errs[m.id].push(Math.min(100, now + demand(ctx, f, t, w.end)) - actual);
      }
    }
  }
  const out = {} as Record<ModelId, BacktestScore>;
  for (const m of MODELS) {
    const e = errs[m.id];
    out[m.id] = {
      mae: e.length ? e.reduce((a, v) => a + Math.abs(v), 0) / e.length : NaN,
      bias: e.length ? e.reduce((a, v) => a + v, 0) / e.length : NaN,
      n: e.length,
    };
  }
  return out;
}

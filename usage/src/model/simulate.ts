// Cross-account simulation. Each account consumes its own forecast demand until
// it reaches the target ceiling (95% by default); from then on its demand is
// shared evenly between the accounts that still have room, water-filling when
// one of those fills up too. Whatever fits nowhere is reported as unmet.
//
// Accounts can be on different plans, so a percentage point is not the same
// amount of work everywhere: demand moves between accounts in "capacity units"
// (pp × capacity / 100), where capacity is each account's relative plan size.

import type { Point } from "./series";
import { HOUR, WEEK, hourIndex } from "./time";

export interface SimAccount {
  id: string;
  pct0: number;
  end0: number;
  capacity: number;
  /** Own forecast demand, pp of this account's limit per hour, at time t. */
  rate: (t: number) => number;
}

export interface SimResult {
  points: Record<string, Point[]>;
  /** Usage just before each account's current window resets. */
  atReset: Record<string, number>;
  /** When each account reaches the ceiling within its current window. */
  hitCap: Record<string, number | null>;
  /** pp of the account's own limit pushed to the others. */
  given: Record<string, number>;
  /** pp of the account's own limit used to absorb the others' overflow. */
  received: Record<string, number>;
  /** Capacity units that fit on no account. */
  unmet: number;
  unmetFrom: number | null;
}

const EPS = 1e-9;

export function simulate(accts: SimAccount[], from: number, until: number, target: number, mult = 1, record = true): SimResult {
  const st = accts.map((a) => ({ a, pct: a.pct0, end: a.end0, first: true }));
  const res: SimResult = { points: {}, atReset: {}, hitCap: {}, given: {}, received: {}, unmet: 0, unmetFrom: null };
  for (const { a } of st) {
    res.points[a.id] = record ? [{ t: from, pct: a.pct0 }] : [];
    res.hitCap[a.id] = null;
    res.given[a.id] = 0;
    res.received[a.id] = 0;
  }
  const capped = (x: (typeof st)[number], t: number) => {
    if (x.first && res.hitCap[x.a.id] == null && x.pct >= target - 1e-6) res.hitCap[x.a.id] = t;
  };

  for (let t = from; t < until; ) {
    for (const x of st) {
      if (t < x.end) continue;
      if (x.first) res.atReset[x.a.id] = x.pct;
      x.first = false;
      x.pct = 0;
      x.end += WEEK;
      if (record) res.points[x.a.id].push({ t, pct: 0 });
    }
    const next = Math.min((hourIndex(t) + 1) * HOUR, until, ...st.map((x) => x.end));
    const frac = (next - t) / HOUR;

    let pool = 0;
    for (const x of st) {
      const want = x.a.rate(t) * frac * mult;
      const take = Math.min(want, Math.max(0, target - x.pct));
      x.pct += take;
      if (want - take > EPS) {
        res.given[x.a.id] += want - take;
        pool += ((want - take) * x.a.capacity) / 100;
        capped(x, t + (take / want) * (next - t));
      }
    }
    for (let i = 0; i < st.length && pool > EPS; i++) {
      const open = st.filter((x) => target - x.pct > EPS);
      if (!open.length) break;
      const share = pool / open.length;
      for (const x of open) {
        const g = Math.min(share, ((target - x.pct) * x.a.capacity) / 100);
        const pp = (g * 100) / x.a.capacity;
        x.pct += pp;
        res.received[x.a.id] += pp;
        pool -= g;
        capped(x, next);
      }
    }
    if (pool > 1e-6) {
      res.unmet += pool;
      res.unmetFrom ??= t;
    }
    t = next;
    if (record) for (const x of st) res.points[x.a.id].push({ t, pct: x.pct });
  }
  for (const x of st) if (x.first) res.atReset[x.a.id] = x.pct;
  return res;
}

/** Largest multiple of the forecast demand that fits on all accounts until `until`. */
export function maxMultiplier(accts: SimAccount[], from: number, until: number, target: number, limit = 10): number {
  const fits = (m: number) => simulate(accts, from, until, target, m, false).unmet <= 1e-4;
  if (fits(limit)) return Infinity;
  let lo = 0;
  let hi = limit;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

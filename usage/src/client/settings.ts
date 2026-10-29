// Dashboard settings, kept in localStorage (per browser; the page works without it).

import { DEFAULT_MODEL_CONFIG, type ModelConfig, type ModelId } from "../model/forecast";

export interface Settings {
  tab: string;
  model: ModelId;
  includePriorWeeks: boolean;
  priorWeeks: number;
  halfLifeWeeks: number;
  weekendMode: "manual" | "learned";
  /** Percent less usage on Saturdays and Sundays. */
  weekendReduction: number;
  /** Per-account weekend reduction in percent; null = use the global setting. */
  weekendOverride: Record<string, number | null>;
  /** Ceiling an account may be filled to before its demand spills to the others. */
  target: number;
  shape: "learned" | "uniform";
  recentDays: number;
  adaptLevel: boolean;
  alpha: number;
  beta: number;
  phi: number;
  weekdayProfile: boolean;
  /** Relative plan size per account; demand moves between accounts in these units. */
  capacity: Record<string, number>;
  /** Forecast horizon in days; 0 = through each account's current reset. */
  horizon: number;
  /** Days of history in the charts; 0 = all. */
  range: number;
  weekendChart: string;
  autoReload: boolean;
  theme: "auto" | "light" | "dark";
}

export const DEFAULTS: Settings = {
  tab: "combined",
  model: "blend",
  includePriorWeeks: DEFAULT_MODEL_CONFIG.includePriorWeeks,
  priorWeeks: DEFAULT_MODEL_CONFIG.priorWeeks,
  halfLifeWeeks: DEFAULT_MODEL_CONFIG.halfLifeWeeks,
  weekendMode: "manual",
  weekendReduction: 80,
  weekendOverride: {},
  target: 95,
  shape: DEFAULT_MODEL_CONFIG.shape,
  recentDays: DEFAULT_MODEL_CONFIG.recentDays,
  adaptLevel: DEFAULT_MODEL_CONFIG.adaptLevel,
  alpha: DEFAULT_MODEL_CONFIG.alpha,
  beta: DEFAULT_MODEL_CONFIG.beta,
  phi: DEFAULT_MODEL_CONFIG.phi,
  weekdayProfile: DEFAULT_MODEL_CONFIG.weekdayProfile,
  capacity: {},
  horizon: 0,
  range: 14,
  weekendChart: "all",
  autoReload: true,
  theme: "auto",
};

const KEY = "claude-usage-dashboard:v1";

export function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...structuredClone(DEFAULTS), ...JSON.parse(raw) };
  } catch {}
  return structuredClone(DEFAULTS);
}

export function save(st: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
  } catch {}
}

export function modelConfig(st: Settings, weekendReduction: number): ModelConfig {
  return {
    includePriorWeeks: st.includePriorWeeks,
    priorWeeks: st.priorWeeks,
    halfLifeWeeks: st.halfLifeWeeks,
    weekendReduction,
    shape: st.shape,
    recentDays: st.recentDays,
    adaptLevel: st.adaptLevel,
    alpha: st.alpha,
    beta: st.beta,
    phi: st.phi,
    weekdayProfile: st.weekdayProfile,
  };
}

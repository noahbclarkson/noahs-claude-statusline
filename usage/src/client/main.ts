// Claude usage dashboard. Data is a snapshot inlined by render.ts; every
// forecast is computed here, so changing a setting re-runs the models instantly.

import { MODELS, type ModelId, modelLabel } from "../model/forecast";
import { type AccountSeries, type Point, type RawSample, buildSeries, dailyUsage } from "../model/series";
import { DAY, HOUR, addDays, dayStart, isWeekend } from "../model/time";
import { type AccountView, type Analysis, analyse, backtestFor } from "./analysis";
import { type LineSeries, type XY, columnChart, lineChart, tableView } from "./charts";
import { button, caption, field, segmented, select, slider, stepper, toggleSwitch } from "./controls";
import { h, icon } from "./dom";
import * as fmt from "./format";
import { DEFAULTS, type Settings, load, save } from "./settings";

interface Payload {
  generatedAt: number;
  accounts: { id: string; label: string; samples: RawSample[] }[];
}

const payload: Payload = JSON.parse(document.getElementById("usage-data")!.textContent!);
const NOW = payload.generatedAt;
const series: AccountSeries[] = payload.accounts.map((a) => buildSeries(a.id, a.label, a.samples, NOW));
let st: Settings = load();
if (location.hash.length > 1) st.tab = decodeURIComponent(location.hash.slice(1));

const app = document.getElementById("app")!;
const content = h("main");

// ---------- small UI helpers ----------

function update(patch: Partial<Settings>, rerenderControls = false): void {
  st = { ...st, ...patch };
  save(st);
  if (rerenderControls) renderShell();
  else scheduleContent();
}

let pending = 0;
function scheduleContent(): void {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(renderContent);
}

/** Save a setting that needs no re-render (theme, auto-reload). */
function persist(patch: Partial<Settings>): void {
  st = { ...st, ...patch };
  save(st);
}

function card(title: string, sub: string | null, ...kids: (Node | null)[]): HTMLElement {
  return h("section", { class: "card" }, h("h2", {}, title), sub ? h("p", { class: "sub" }, sub) : null, ...kids);
}

const ICONS = {
  good: '<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  warning: '<path d="M8 2l6.5 11.5h-13z" fill="currentColor"/><path d="M8 6.5v3.2M8 11.6v.2" stroke="var(--surface)" stroke-width="1.6" stroke-linecap="round"/>',
  critical: '<circle cx="8" cy="8" r="6.5" fill="currentColor"/><path d="M8 4.6v4M8 10.9v.2" stroke="var(--surface)" stroke-width="1.7" stroke-linecap="round"/>',
};
function status(kind: keyof typeof ICONS, text: string): HTMLElement {
  const el = h("span", { class: `status ${kind}` });
  el.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">${ICONS[kind]}</svg>`;
  el.append(text);
  return el;
}

function meter(value: number, target: number, color: string): HTMLElement {
  const m = h("div", { class: "meter", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(value)) });
  const fill = h("span");
  fill.style.width = `${Math.min(100, value)}%`;
  fill.style.background = color;
  const mark = h("i", { title: `${target}% ceiling` });
  mark.style.left = `${target}%`;
  m.append(fill, mark);
  return m;
}

function tile(label: Node | string, value: Node | string, ...detail: (Node | string | null)[]): HTMLElement {
  return h("div", { class: "card tile" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), ...detail.filter(Boolean).map((d) => (typeof d === "string" ? h("div", { class: "detail" }, d) : d!)));
}

const dotEl = (color: string) => {
  const d = h("span", { class: "dot", "aria-hidden": "true" });
  d.style.background = color;
  return d;
};
const accountLabel = (a: AccountView) => h("span", { class: "label" }, dotEl(a.color), a.label);
const inTime = (t: number) => `${fmt.dateTime(t)} (in ${fmt.duration(t - NOW)})`;
const rangeStart = () => (st.range > 0 ? NOW - st.range * DAY : Math.min(...series.filter((s) => s.firstObs != null).map((s) => s.firstObs!)));

// ---------- chart data ----------

/** Weekly usage as a step series: 0 at each reset, each reading, held to the window's end. */
function weeklyHistory(s: AccountSeries, from: number): XY[] {
  const out: XY[] = [];
  s.windows.forEach((w, i) => {
    if (w.end < from) return;
    if (i > 0) out.push({ x: w.start, y: 0 });
    for (const p of w.points) out.push({ x: p.t, y: p.pct });
    out.push({ x: Math.min(w.end, NOW), y: w.points[w.points.length - 1].pct });
  });
  return out;
}

function fiveHistory(s: AccountSeries, from: number): XY[] {
  const out: XY[] = [];
  let last: (typeof s.five)[number] | null = null;
  for (const p of s.five) {
    if (p.t < from) {
      last = p;
      continue;
    }
    if (last?.reset != null && p.t > last.reset) out.push({ x: last.reset, y: 0 });
    out.push({ x: p.t, y: p.pct });
    last = p;
  }
  if (last) {
    if (last.reset != null && NOW > last.reset) out.push({ x: last.reset, y: 0 }, { x: NOW, y: 0 });
    else out.push({ x: NOW, y: last.pct });
  }
  return out;
}

const toXY = (pts: Point[]): XY[] => pts.map((p) => ({ x: p.t, y: p.pct }));
const yTop = (...vals: number[]) => Math.min(150, Math.max(100, Math.ceil(Math.max(...vals) / 10) * 10));

function valueAtEnd(pts: XY[], x: number): number | null {
  let v: number | null = null;
  for (const p of pts) {
    if (p.x > x) break;
    v = p.y;
  }
  return v;
}

// ---------- shell ----------

function header(): HTMLElement {
  const age = Math.max(0, Date.now() / 1000 - NOW);
  const newest = Math.max(...series.map((s) => s.lastObs ?? 0));
  const quiet = NOW - newest;
  const theme = segmented<Settings["theme"]>({
    label: "Theme",
    value: st.theme,
    iconOnly: true,
    options: [
      { value: "auto", label: "Match system", icon: "system" },
      { value: "light", label: "Light", icon: "sun" },
      { value: "dark", label: "Dark", icon: "moon" },
    ],
    onChange: (v) => {
      persist({ theme: v });
      applyTheme();
    },
  });
  const reload = toggleSwitch({ label: "Auto-reload", checked: st.autoReload, onChange: (v) => persist({ autoReload: v }) });
  return h(
    "header",
    { class: "top" },
    h("h1", {}, "Claude usage"),
    h(
      "div",
      { class: "top-meta" },
      h("span", { class: "asof" }, `Data as of ${fmt.dateTime(NOW)}${age > 120 ? ` · ${fmt.duration(age)} ago` : ""}`),
      quiet > 2 * HOUR ? h("span", { class: "stale" }, icon("alert"), `No new readings for ${fmt.duration(quiet)}`) : null,
      reload.el,
      theme.el,
    ),
  );
}

function tabs(): HTMLElement {
  const nav = h("nav", { class: "tabs", role: "tablist", "aria-label": "Views" });
  const items: { id: string; text: string; color?: string }[] = [
    { id: "combined", text: "All accounts" },
    ...series.map((s, i) => ({ id: s.id, text: s.label, color: `var(--series-${i + 1})` })),
    { id: "weekends", text: "Weekends" },
  ];
  const btns = items.map((it) => {
    const selected = st.tab === it.id;
    const b = h(
      "button",
      { type: "button", role: "tab", id: `tab-${it.id}`, "aria-selected": String(selected), "aria-controls": "panel", tabindex: selected ? "0" : "-1" },
      it.color ? dotEl(it.color) : null,
      it.text,
    );
    b.addEventListener("click", () => {
      if (st.tab === it.id) return;
      history.replaceState(null, "", `#${it.id}`);
      update({ tab: it.id }, true);
      document.getElementById(`tab-${it.id}`)?.focus();
    });
    nav.append(b);
    return b;
  });
  // Arrow keys move between tabs; Enter or Space opens one (views are heavy to render).
  nav.addEventListener("keydown", (ev) => {
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const n = btns.length;
    const j = ({ ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 } as Record<string, number>)[ev.key];
    if (i < 0 || j === undefined) return;
    ev.preventDefault();
    btns.forEach((b, k) => (b.tabIndex = k === j ? 0 : -1));
    btns[j].focus();
  });
  return nav;
}

let settingsOpen = false;

function toolbar(panel: HTMLElement): HTMLElement {
  const prior = stepper({ label: "Prior weeks", value: st.priorWeeks, min: 1, max: 12, step: 1, unit: "wk", onChange: (v) => update({ priorWeeks: v! }) });
  prior.setDisabled(!st.includePriorWeeks);
  const learn = toggleSwitch({
    label: "Learn from prior weeks",
    hideLabel: true,
    checked: st.includePriorWeeks,
    onChange: (v) => {
      prior.setDisabled(!v);
      update({ includePriorWeeks: v });
    },
  });

  return h(
    "section",
    { class: "toolbar", "aria-label": "Forecast settings" },
    h(
      "div",
      { class: "toolbar-row" },
      field("Chart range", segmented({ label: "Chart range", value: st.range, options: [7, 14, 30, 90, 0].map((v) => ({ value: v, label: v ? `${v}d` : "All" })), onChange: (v) => update({ range: v }) }).el),
      field("Forecast model", select<ModelId>({ label: "Forecast model", value: st.model, options: MODELS.map((m) => ({ value: m.id, label: m.label, detail: m.blurb })), onChange: (v) => update({ model: v }) }).el),
      field("Forecast to", segmented({ label: "Forecast to", value: st.horizon, options: [0, 7, 14].map((v) => ({ value: v, label: v ? `${v} days` : "Each reset" })), onChange: (v) => update({ horizon: v }) }).el),
      field("Learn from prior weeks", [learn.el, prior.el]),
      field("Weekends", slider({ label: "Weekend usage", value: st.weekendReduction, min: 0, max: 100, step: 5, format: (v) => `${v}% less`, onInput: (v) => update({ weekendReduction: v }) }).el),
      field("Ceiling", stepper({ label: "Ceiling", value: st.target, min: 50, max: 100, step: 1, unit: "%", onChange: (v) => update({ target: v! }) }).el),
    ),
    panel,
  );
}

function settingsPanel(): HTMLElement {
  const num = (label: string, value: number, min: number, max: number, step: number, unit: string | undefined, on: (v: number) => void) =>
    stepper({ label, value, min, max, step, unit, onChange: (v) => on(v!) }).el;
  const pair = (cap: Node | string, control: Node) => h("span", { class: "inline-pair" }, typeof cap === "string" ? caption(cap) : cap, control);
  return h(
    "div",
    { class: "settings-panel", id: "model-settings" },
    h(
      "div",
      { class: "settings-grid" },
      field("Recency half-life", num("Recency half-life", st.halfLifeWeeks, 0, 12, 0.5, "wk", (v) => update({ halfLifeWeeks: v })), "A week this old counts half as much. 0 weighs every week equally."),
      field(
        "Time of day",
        segmented({ label: "Time-of-day shape", value: st.shape, options: [{ value: "learned", label: "Learned" }, { value: "uniform", label: "Even" }], onChange: (v) => update({ shape: v }) }).el,
        "How a forecast day is spread across its hours. Learned uses your last 8 weeks.",
      ),
      field("Recent pace window", num("Recent pace window", st.recentDays, 1, 14, 1, "days", (v) => update({ recentDays: v })), "How far back Recent pace looks."),
      field("Weekday pattern", toggleSwitch({ label: "Adapt to this week", checked: st.adaptLevel, onChange: (v) => update({ adaptLevel: v }) }).el, "Scale the usual weekday pattern by how far ahead or behind this week is."),
      field(
        "Smoothed trend",
        [
          pair("α", num("Smoothed trend α, level", st.alpha, 0.05, 1, 0.05, undefined, (v) => update({ alpha: v }))),
          pair("β", num("Smoothed trend β, trend", st.beta, 0, 1, 0.05, undefined, (v) => update({ beta: v }))),
          pair("φ", num("Smoothed trend φ, damping", st.phi, 0.5, 1, 0.02, undefined, (v) => update({ phi: v }))),
          toggleSwitch({ label: "Weekday profile", checked: st.weekdayProfile, onChange: (v) => update({ weekdayProfile: v }) }).el,
        ],
        "α: how fast the level reacts. β: how fast the trend reacts. φ: trend damping, where 1 is none.",
      ),
      field(
        "Plan size",
        series.map((s, i) => pair(caption(dotEl(`var(--series-${i + 1})`), s.label), num(`${s.label} plan size`, st.capacity[s.id] || 1, 0.25, 20, 0.25, "×", (v) => update({ capacity: { ...st.capacity, [s.id]: v } })))),
        "Relative weekly limit, used when sharing overflow (Max 20× = 4, Max 5× = 1). Leave at 1 when the plans match.",
      ),
    ),
    h(
      "div",
      { class: "settings-foot" },
      button(
        "Reset all settings",
        () => {
          st = { ...structuredClone(DEFAULTS), tab: st.tab };
          save(st);
          applyTheme();
          renderShell();
        },
        { variant: "ghost", size: "sm", icon: "reset" },
      ),
    ),
  );
}

function renderShell(): void {
  content.id = "panel";
  content.setAttribute("role", "tabpanel");
  content.setAttribute("aria-labelledby", `tab-${st.tab}`);
  const panel = settingsPanel();
  panel.hidden = !settingsOpen;
  const toggle = button(
    "Model settings",
    () => {
      settingsOpen = !settingsOpen;
      panel.hidden = !settingsOpen;
      toggle.setAttribute("aria-expanded", String(settingsOpen));
    },
    { variant: "ghost", icon: "sliders" },
  );
  toggle.setAttribute("aria-expanded", String(settingsOpen));
  toggle.setAttribute("aria-controls", "model-settings");
  toggle.setAttribute("aria-label", "Model settings"); // the text is hidden on phones
  app.replaceChildren(h("div", { class: "wrap" }, header(), h("div", { class: "tabbar" }, tabs(), toggle), toolbar(panel), content));
  renderContent();
}

/** Identifies a control across re-renders, so focus survives a view rebuilding itself. */
function focusKey(el: Element | null): string | null {
  if (!el || !content.contains(el)) return null;
  return `${el.tagName}|${el.getAttribute("role") ?? ""}|${el.getAttribute("aria-label") ?? el.textContent?.trim() ?? ""}`;
}

function renderContent(): void {
  const key = focusKey(document.activeElement);
  const A = analyse(series, st, NOW);
  const acct = A.accounts.find((a) => a.id === st.tab);
  const body = st.tab === "weekends" ? weekendsView(A) : acct ? accountView(acct) : combinedView(A);
  content.replaceChildren(body);
  if (!key) return;
  for (const el of content.querySelectorAll<HTMLElement>("button, input, [tabindex]")) {
    if (focusKey(el) === key) {
      el.focus({ preventScroll: true });
      break;
    }
  }
}

function applyTheme(): void {
  if (st.theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = st.theme;
}

// ---------- All accounts ----------

function combinedView(A: Analysis): HTMLElement {
  const C = A.combined;
  if (!C.sim) return h("div", { class: "card empty" }, "No usage readings yet. They appear once a Claude Code session has been open for a few minutes.");
  const root = h("div", { class: "grid" });
  const m = C.mult;
  const ceiling = `${st.target}%`;
  const kind = m >= 1.1 ? "good" : m >= 1 ? "warning" : "critical";
  const headline = m >= 1 ? "Room to speed up" : "Slow down";
  const caps = C.members
    .filter((a) => C.sim!.hitCap[a.id] != null)
    .sort((a, b) => C.sim!.hitCap[a.id]! - C.sim!.hitCap[b.id]!)
    .map((a) => `${a.label} reaches ${ceiling} ${fmt.weekdayTime(C.sim!.hitCap[a.id]!)}`);
  const share = caps.length ? `${caps.join("; ")}. From then on its forecast usage is shared evenly between the accounts with room left.` : `No account is forecast to reach ${ceiling} before it resets.`;
  const explain =
    m >= 1
      ? Number.isFinite(m)
        ? `With the ${modelLabel(st.model)} forecast, every account stays under ${ceiling} until it resets, even with ${fmt.change(m).slice(1)} more usage spread across them.`
        : `With the ${modelLabel(st.model)} forecast, the accounts use only a small fraction of their room before they reset.`
      : `Forecast usage is more than the three accounts can absorb under ${ceiling} before they reset. Using about ${Math.round((1 - m) * 100)}% less across them keeps everything under the ceiling.`;

  root.append(
    h(
      "section",
      { class: "card hero" },
      h("div", {}, h("div", { class: "hero-label" }, "Combined pace headroom"), h("div", { class: "hero-figure" }, Number.isFinite(m) ? fmt.change(m) : "Plenty")),
      h("div", {}, status(kind, headline), h("p", {}, explain), h("p", { class: "text-2" }, share), C.sim.unmet > 0.05 ? h("div", { class: "callout", role: "note" }, icon("alert"), `From ${fmt.dateTime(C.sim.unmetFrom!)}, ${fmt.pp(C.sim.unmet * 100)} pp of forecast usage has nowhere to go (100 pp is one account's whole week).`) : null),
    ),
  );

  const tiles = h("div", { class: "grid tiles" });
  for (const a of A.accounts) {
    if (!a.has || !a.cw) {
      tiles.append(tile(accountLabel(a), "No data", "Readings start when this profile opens a session."));
      continue;
    }
    const shared = C.sim.atReset[a.id];
    tiles.append(
      tile(
        accountLabel(a),
        h("span", {}, fmt.pct(a.cw.pct), h("small", {}, " used")),
        meter(a.cw.pct, st.target, a.color),
        `Resets ${inTime(a.cw.end)}`,
        a.proj ? `Forecast at reset: ${fmt.pct(a.proj.atReset)} on its own${shared != null ? `, ${fmt.pct(shared)} with sharing` : ""}` : null,
        `5-hour window: ${fmt.pct(a.five.pct)}${a.five.reset ? `, resets ${fmt.time(a.five.reset)}` : ""}`,
      ),
    );
  }
  root.append(tiles);

  const from = rangeStart();
  const lines: LineSeries[] = [];
  let maxY = 100;
  for (const a of C.members) {
    lines.push({ key: `${a.id}-h`, label: a.label, color: a.color, points: weeklyHistory(a.s, from), step: true });
    const sp = C.sim.points[a.id];
    maxY = Math.max(maxY, ...sp.map((p) => p.pct));
    lines.push({ key: `${a.id}-f`, label: `${a.label} forecast`, color: a.color, points: toXY(sp), dashed: true, legend: false });
  }
  root.append(
    card(
      "Weekly usage, all accounts",
      `Solid: actual. Dashed: ${modelLabel(st.model)} forecast after sharing overflow above ${ceiling}. Shaded columns are weekends.`,
      lineChart({ series: lines, xKind: "time", xMin: from, xMax: C.until, yMax: yTop(maxY), yFmt: fmt.pct, refLines: [{ y: st.target, label: `${ceiling} ceiling` }], now: NOW, weekends: true, ariaLabel: "Weekly usage per account over time with forecast", legendExtra: [{ label: "Forecast", kind: "dashed", color: "var(--text-2)" }] }),
      dayTable(from, C.until, C.members.map((a) => ({ label: a.label, pts: [...lines.find((l) => l.key === `${a.id}-h`)!.points, ...toXY(C.sim!.points[a.id])] }))),
    ),
  );

  const rows = C.members.map((a) => {
    const hit = C.sim!.hitCap[a.id];
    return [
      a.label,
      fmt.pct(a.cw!.pct),
      fmt.dateTime(a.cw!.end),
      a.proj ? fmt.pct(a.proj.atReset) : "–",
      fmt.pct(C.sim!.atReset[a.id] ?? a.cw!.pct),
      hit ? fmt.dateTime(hit) : "Not before reset",
      C.sim!.given[a.id] >= 0.5 ? `${fmt.pp(C.sim!.given[a.id])} pp` : "–",
      C.sim!.received[a.id] >= 0.5 ? `${fmt.pp(C.sim!.received[a.id])} pp` : "–",
    ];
  });
  root.append(
    card(
      "Sharing the load",
      `Each account uses its own forecast until it reaches ${ceiling}; after that its usage is split evenly across the accounts that still have room.`,
      h("div", { class: "table-wrap" }, simpleTable(["Account", "Now", "Resets", "On its own", "With sharing", `Reaches ${ceiling}`, "Moved out", "Taken in"], rows, [false, true, false, true, true, false, true, true])),
    ),
  );

  root.append(card("Daily usage, all accounts", "Percentage points of each account's weekly limit used per day, stacked. Lighter segments are forecast, after sharing.", combinedDaily(A, from)));
  return root;
}

function combinedDaily(A: Analysis, from: number): HTMLElement {
  const C = A.combined;
  const today = dayStart(NOW);
  const cats: { start: number }[] = [];
  for (let d = dayStart(from); d < C.until; d = addDays(d, 1)) cats.push({ start: d });
  const used = C.members.map((a) => {
    const byDay = new Map(dailyUsage(a.s, from).map((d) => [d.start, d.usage]));
    return { key: `${a.id}-u`, label: a.label, color: a.color, values: cats.map((c) => (c.start <= today ? byDay.get(c.start) ?? 0 : 0)) };
  });
  const fc = C.members.map((a) => ({ key: `${a.id}-f`, label: `${a.label} forecast`, color: a.color, opacity: 0.4, legend: false, values: cats.map((c) => C.simDaily[a.id]?.get(c.start) ?? 0) }));
  const all = [...used, ...fc];
  return h(
    "div",
    {},
    columnChart({
      cats: cats.map((c) => ({ label: fmt.dayShort(c.start), title: fmt.dayLabel(c.start), weekend: isWeekend(c.start) })),
      series: all,
      mode: "stacked",
      yFmt: (v) => fmt.pp(v),
      ariaLabel: "Daily usage per account, stacked",
      forecastLegend: true,
    }),
    tableView(["Day", ...all.map((s) => s.label)], cats.map((c, i) => [fmt.dayLabel(c.start), ...all.map((s) => fmt.pp(s.values[i]))]), [false, ...all.map(() => true)]),
  );
}

function dayTable(from: number, to: number, cols: { label: string; pts: XY[] }[]): HTMLElement {
  const rows: string[][] = [];
  for (let d = addDays(dayStart(from), 1); d <= to + DAY; d = addDays(d, 1)) {
    const t = Math.min(d, to);
    rows.push([`${fmt.dayLabel(t - 1)}${t > NOW ? " (forecast)" : ""}`, ...cols.map((c) => {
      const v = valueAtEnd([...c.pts].sort((a, b) => a.x - b.x), t);
      return v == null ? "–" : fmt.pct(v);
    })]);
    if (t === to) break;
  }
  return tableView(["End of day", ...cols.map((c) => c.label)], rows, [false, ...cols.map(() => true)]);
}

function simpleTable(headers: string[], rows: (string | Node)[][], numeric: boolean[] = []): HTMLTableElement {
  return h(
    "table",
    {},
    h("thead", {}, h("tr", {}, ...headers.map((t, i) => h("th", { class: numeric[i] ? "num" : undefined }, t)))),
    h("tbody", {}, ...rows.map((r) => h("tr", {}, ...r.map((v, i) => h("td", { class: numeric[i] ? "num" : undefined }, v))))),
  );
}

// ---------- One account ----------

function accountView(a: AccountView): HTMLElement {
  if (!a.has || !a.cw) return h("div", { class: "card empty" }, `No readings for ${a.label} yet. They start the first time this profile has a Claude Code session open.`);
  const root = h("div", { class: "grid" });
  const cw = a.cw;
  const p = a.proj;
  const ceiling = `${st.target}%`;
  const resets = Object.values(a.projBy).map((pr) => pr.atReset);
  const bandAtReset = resets.length > 1 ? { lo: Math.min(...resets), hi: Math.max(...resets) } : null;

  const paceTile = (() => {
    if (!a.pace || !p) return tile("Pace", "–", a.chosen.note ?? "");
    const m = a.pace.mult;
    const kind = m >= 1.1 ? "good" : m >= 1 ? "warning" : "critical";
    const text = m >= 1 ? "Room to speed up" : "Slow down";
    return tile(
      "Pace to the ceiling",
      Number.isFinite(m) ? fmt.change(m) : "Plenty",
      status(kind, text),
      `Budget ${fmt.pp(a.pace.budgetPerWeekday)} pp per weekday until reset; the forecast uses ${fmt.pp(a.pace.forecastPerWeekday)}.`,
    );
  })();

  root.append(
    h(
      "div",
      { class: "grid tiles" },
      tile(accountLabel(a), h("span", {}, fmt.pct(cw.pct), h("small", {}, " of weekly limit")), meter(cw.pct, st.target, a.color), `Resets ${inTime(cw.end)}`),
      p
        ? tile("Forecast at reset", fmt.pct(p.atReset), `${modelLabel(st.model)}${bandAtReset ? `; models range ${fmt.pct(bandAtReset.lo)}–${fmt.pct(bandAtReset.hi)}` : ""}`, a.chosen.note ?? null)
        : tile("Forecast at reset", "–", a.chosen.note ?? "Not enough history yet."),
      p ? tile(`Reaches ${ceiling}`, p.hitTarget ? fmt.weekdayTime(p.hitTarget) : "Not before reset", p.hit100 ? `Hits 100% ${fmt.dateTime(p.hit100)}` : `Stays under 100% until ${fmt.weekdayTime(cw.end)}`) : tile(`Reaches ${ceiling}`, "–"),
      paceTile,
      tile(
        "5-hour window",
        fmt.pct(a.five.pct),
        a.five.reset ? `Resets ${fmt.time(a.five.reset)} (in ${fmt.duration(a.five.reset - NOW)}); on pace for ${fmt.pct(fivePace(a))}` : "No active 5-hour window",
      ),
    ),
  );

  const two = h("div", { class: "grid two" });
  two.append(card("This window against previous ones", "Weekly usage by time since reset. Gray lines are earlier windows; the dashed line is the forecast and the shaded band is the spread across all models.", windowCompare(a)));
  const from = rangeStart();
  const histPts = weeklyHistory(a.s, from);
  const fc = p ? toXY(p.points) : [];
  two.append(
    card(
      "Weekly usage over time",
      "Shaded columns are weekends.",
      lineChart({
        series: [
          { key: "h", label: "Actual", color: a.color, points: histPts, step: true },
          { key: "f", label: `${modelLabel(st.model)} forecast`, color: a.color, points: fc, dashed: true, band: a.band },
        ],
        xKind: "time",
        xMin: from,
        xMax: a.until,
        yMax: yTop(...fc.map((x) => x.y)),
        yFmt: fmt.pct,
        refLines: [{ y: st.target, label: `${ceiling} ceiling` }],
        now: NOW,
        weekends: true,
        ariaLabel: `${a.label} weekly usage over time`,
        legendExtra: [{ label: "Model range", kind: "band", color: a.color }],
      }),
      dayTable(from, a.until, [{ label: "Actual / forecast", pts: [...histPts, ...fc] }]),
    ),
  );
  root.append(two);

  root.append(modelsCard(a));

  const two2 = h("div", { class: "grid two" });
  two2.append(card("5-hour window", "The rolling 5-hour limit, as reported to the status line.", fiveChart(a, from)));
  two2.append(card("Daily usage", "Percentage points of the weekly limit used per day. Lighter: forecast.", accountDaily(a, from)));
  root.append(two2);
  return root;
}

function fivePace(a: AccountView): number {
  if (!a.five.reset) return a.five.pct;
  const start = a.five.reset - 5 * HOUR;
  const elapsed = Math.max(HOUR / 4, NOW - start);
  return a.five.pct + (a.five.pct / elapsed) * Math.max(0, a.five.reset - NOW);
}

function windowCompare(a: AccountView): HTMLElement {
  const cw = a.cw!;
  const toRel = (t: number, start: number) => (t - start) / DAY;
  const lines: LineSeries[] = [];
  const priors = a.s.windows.filter((w) => w.end <= cw.start && (a.s.firstObs ?? 0) <= w.start).slice(-(st.includePriorWeeks ? st.priorWeeks : 4));
  priors.forEach((w) => {
    const pts: XY[] = [{ x: 0, y: 0 }, ...w.points.map((p) => ({ x: toRel(p.t, w.start), y: p.pct })), { x: 7, y: w.points[w.points.length - 1].pct }];
    lines.push({ key: `w${w.end}`, label: `Week to ${fmt.date(w.end)}`, color: "var(--prior-line)", points: pts, muted: true, step: true, legend: false });
  });
  const curW = a.s.windows.find((w) => w.end === cw.end);
  const cur: XY[] = [{ x: 0, y: 0 }, ...(curW?.points ?? []).map((p) => ({ x: toRel(p.t, cw.start), y: p.pct })), { x: toRel(NOW, cw.start), y: cw.pct }];
  lines.push({ key: "cur", label: "This window", color: a.color, points: cur, step: true });
  const inWin = (x: { t: number }) => x.t <= cw.end;
  const fc = (a.proj?.points ?? []).filter(inWin).map((p) => ({ x: toRel(p.t, cw.start), y: p.pct }));
  const band = a.band.filter((b) => b.x <= cw.end).map((b) => ({ x: toRel(b.x, cw.start), lo: b.lo, hi: b.hi }));
  if (fc.length) lines.push({ key: "fc", label: "Forecast", color: a.color, points: fc, dashed: true, band });
  const extra: { label: string; kind: "band" | "line" | "dashed"; color: string }[] = [{ label: "Model range", kind: "band", color: a.color }];
  if (priors.length) extra.unshift({ label: "Earlier windows", kind: "line", color: "var(--prior-line)" });

  const tableRows: string[][] = [];
  for (let x = 1; x <= 7; x++) tableRows.push([fmt.weekdayTime(cw.start + x * DAY), ...lines.map((l) => {
    const v = valueAtEnd(l.points, x);
    return v == null ? "–" : fmt.pct(v);
  })]);
  return h(
    "div",
    {},
    lineChart({
      series: lines,
      xKind: "days",
      xMin: 0,
      xMax: 7,
      yMax: yTop(...fc.map((x) => x.y), ...band.map((b) => b.hi)),
      yFmt: fmt.pct,
      xFmt: (x) => fmt.weekday(cw.start + x * DAY),
      tipTitle: (x) => `${fmt.weekdayTime(cw.start + x * DAY)} · day ${(x + 0.0001).toFixed(1)} of 7`,
      refLines: [{ y: st.target, label: `${st.target}% ceiling` }],
      now: toRel(NOW, cw.start),
      ariaLabel: `${a.label} weekly usage by time since reset, compared with earlier windows`,
      legendExtra: extra,
    }),
    tableView(["Since reset", ...lines.map((l) => l.label)], tableRows, [false, ...lines.map(() => true)]),
  );
}

function modelsCard(a: AccountView): HTMLElement {
  const bt = backtestFor(a);
  const rows = MODELS.map((m) => {
    const f = a.set[m.id];
    const pr = a.projBy[m.id];
    const b = bt[m.id];
    const tr = h(
      "tr",
      { class: `pick${st.model === m.id ? " selected" : ""}`, tabindex: "0", "aria-selected": String(st.model === m.id) },
      h("td", {}, h("b", {}, m.label), h("span", { class: "note" }, m.blurb)),
      h("td", { class: "num" }, pr ? fmt.pct(pr.atReset) : "–"),
      h("td", {}, pr ? (pr.hitTarget ? fmt.weekdayTime(pr.hitTarget) : "Not before reset") : "–"),
      h("td", { class: "num" }, b.n ? `±${fmt.pp(b.mae)} pp` : "–"),
      h("td", { class: "num" }, b.n ? `${b.bias >= 0 ? "+" : "−"}${fmt.pp(Math.abs(b.bias))} pp` : "–"),
      h("td", { class: "num" }, String(b.n || "–")),
      h("td", {}, h("span", { class: "note" }, f.ok ? f.note ?? "" : `Can't run: ${f.note}`)),
    );
    const pick = () => update({ model: m.id }, true);
    tr.addEventListener("click", pick);
    tr.addEventListener("keydown", (ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), pick()));
    return tr;
  });
  const best = MODELS.filter((m) => bt[m.id].n >= 3).sort((x, y) => bt[x.id].mae - bt[y.id].mae)[0];
  return card(
    "Forecast models",
    `Click a model to use it everywhere. Backtest: every finished window replayed from 1 to 6 days after its reset, using only the data available then, against where it actually finished${best ? `. Most accurate here so far: ${best.label}` : ""}.`,
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, ...["Model", "At reset", `Reaches ${st.target}%`, "Typical error", "Bias", "Tests", "Notes"].map((t, i) => h("th", { class: [1, 3, 4, 5].includes(i) ? "num" : undefined }, t)))),
        h("tbody", {}, ...rows),
      ),
    ),
  );
}

function fiveChart(a: AccountView, from: number): HTMLElement {
  const pts = fiveHistory(a.s, from);
  const peaks = new Map<number, number>();
  for (const p of a.s.five) if (p.reset != null && p.t >= from) peaks.set(p.reset, Math.max(peaks.get(p.reset) ?? 0, p.pct));
  const list = [...peaks.entries()].sort((x, y) => y[0] - x[0]);
  const full = list.filter(([, v]) => v >= 90).length;
  return h(
    "div",
    {},
    lineChart({ series: [{ key: "5h", label: "5-hour usage", color: a.color, points: pts, step: true }], xKind: "time", xMin: from, xMax: NOW, yMax: 100, yFmt: fmt.pct, refLines: [{ y: 100, label: "limit" }], weekends: true, height: 200, ariaLabel: `${a.label} 5-hour window usage` }),
    h("p", { class: "sub" }, `${list.length} five-hour windows in this range; ${full} reached 90% or more.`),
    tableView(["Window ends", "Peak"], list.map(([r, v]) => [fmt.dateTime(r), fmt.pct(v)]), [false, true]),
  );
}

function accountDaily(a: AccountView, from: number): HTMLElement {
  const today = dayStart(NOW);
  const byDay = new Map(dailyUsage(a.s, from).map((d) => [d.start, d.usage]));
  const cats: number[] = [];
  for (let d = dayStart(from); d < a.until; d = addDays(d, 1)) cats.push(d);
  const used = cats.map((d) => (d <= today ? byDay.get(d) ?? 0 : 0));
  const fcDay = new Map<number, number>();
  if (a.proj) {
    const pts = a.proj.points;
    for (let i = 1; i < pts.length; i++) if (pts[i].t > pts[i - 1].t && pts[i].pct >= pts[i - 1].pct) fcDay.set(dayStart(pts[i - 1].t), (fcDay.get(dayStart(pts[i - 1].t)) ?? 0) + pts[i].pct - pts[i - 1].pct);
  }
  const fc = cats.map((d) => fcDay.get(d) ?? 0);
  const sers = [
    { key: "u", label: "Used", color: a.color, values: used },
    { key: "f", label: "Forecast", color: a.color, opacity: 0.4, values: fc },
  ];
  return h(
    "div",
    {},
    columnChart({ cats: cats.map((d) => ({ label: fmt.dayShort(d), title: fmt.dayLabel(d), weekend: isWeekend(d) })), series: sers, mode: "stacked", yFmt: (v) => fmt.pp(v), height: 200, ariaLabel: `${a.label} daily usage` }),
    tableView(["Day", "Used (pp)", "Forecast (pp)"], cats.map((d, i) => [fmt.dayLabel(d), fmt.pp(used[i]), fmt.pp(fc[i])]), [false, true, true]),
  );
}

// ---------- Weekends ----------

function weekendsView(A: Analysis): HTMLElement {
  const root = h("div", { class: "grid" });
  const rec = (r: number | null) => (r == null ? "–" : `${Math.round(r * 100)}% lighter`);
  const rows = A.accounts.map((a) => {
    const ws = a.weekend.stats;
    const ov = st.weekendOverride[a.id];
    const override = stepper({
      label: `${a.label} weekend reduction`,
      value: ov ?? null,
      min: 0,
      max: 100,
      step: 5,
      unit: "%",
      nullable: true,
      placeholder: st.weekendReduction,
      onChange: (v) => update({ weekendOverride: { ...st.weekendOverride, [a.id]: v } }),
    });
    const useRec = button("Use history", () => update({ weekendOverride: { ...st.weekendOverride, [a.id]: Math.round((ws.reduction ?? 0) * 100) } }), {
      size: "sm",
      icon: "history",
      disabled: ws.reduction == null,
      title: ws.reduction == null ? "Needs a full Monday–Sunday week of data" : `Set to ${Math.round(ws.reduction * 100)}% less`,
    });
    const clear = button("Clear", () => update({ weekendOverride: { ...st.weekendOverride, [a.id]: null } }), { size: "sm", variant: "ghost", disabled: ov == null });
    const using = `${Math.round(a.weekend.applied * 100)}% less (${a.weekend.source === "override" ? "this account" : a.weekend.source === "learned" ? "from history" : "global setting"})`;
    return [
      h("span", { class: "acct" }, dotEl(a.color), a.label),
      String(ws.weeks.length),
      ws.weeks.length ? `${fmt.pp(ws.weekdayAvg)} pp` : "–",
      ws.weeks.length ? `${fmt.pp(ws.weekendAvg)} pp` : "–",
      rec(ws.reduction),
      using,
      h("span", { class: "cell-controls" }, override.el, useRec, clear),
    ];
  });
  const cw = A.combined.weekend;
  rows.push([h("b", {}, "All accounts"), String(cw.weeks.length), cw.weeks.length ? `${fmt.pp(cw.weekdayAvg)} pp` : "–", cw.weeks.length ? `${fmt.pp(cw.weekendAvg)} pp` : "–", rec(cw.reduction), "", ""]);

  const recAll = cw.reduction;
  root.append(
    card(
      "Weekend usage",
      null,
      h(
        "div",
        { class: "prose" },
        h("p", {}, `Every forecast assumes Saturdays and Sundays use less than weekdays. The default is 80% less; the global slider above sets it for every account, and an account's own setting below overrides it.`),
        h("p", {}, `History compares each full Monday–Sunday week's average weekend day with its average weekday, weighting recent weeks more (a week 4 weeks old counts half).${recAll != null ? ` Across all accounts your weekends have been ${Math.round(recAll * 100)}% lighter.` : ""}`),
      ),
      h(
        "div",
        { class: "control-row" },
        field(
          "Forecasts use",
          segmented({
            label: "Weekend setting",
            value: st.weekendMode,
            options: [
              { value: "manual", label: `Global, ${st.weekendReduction}% less` },
              { value: "learned", label: "Account history" },
            ],
            onChange: (v) => update({ weekendMode: v }),
          }).el,
        ),
        recAll != null ? button(`Set the global slider to ${Math.round((recAll * 100) / 5) * 5}%`, () => update({ weekendReduction: Math.round((recAll * 100) / 5) * 5 }, true), { icon: "history" }) : null,
      ),
      h("div", { class: "table-wrap" }, simpleTable(["Account", "Full weeks", "Weekday avg", "Weekend day avg", "Historical", "Forecasts use", "This account"], rows, [false, true, true, true, false, false, false])),
    ),
  );

  const pick = st.weekendChart;
  const src = pick === "all" ? { label: "All accounts", color: "var(--text-2)", stats: cw } : (() => {
    const a = A.accounts.find((x) => x.id === pick) ?? A.accounts[0];
    return { label: a.label, color: a.color, stats: a.weekend.stats };
  })();
  const weeks = src.stats.weeks;
  root.append(
    card(
      "Weekdays against weekends, week by week",
      "Average percentage points used per weekday and per weekend day in each full week.",
      h("div", { class: "control-row" }, segmented({ label: "Weekend chart account", value: pick, options: [{ value: "all", label: "All accounts" }, ...A.accounts.map((a) => ({ value: a.id, label: a.label }))], onChange: (v) => update({ weekendChart: v }) }).el),
      weeks.length
        ? h(
            "div",
            {},
            columnChart({
              cats: weeks.map((w) => ({ label: fmt.date(w.start), title: `Week of ${fmt.dayLabel(w.start)}` })),
              series: [
                { key: "wd", label: "Weekday average", color: src.color, values: weeks.map((w) => w.weekday) },
                { key: "we", label: "Weekend day average", color: src.color, opacity: 0.45, values: weeks.map((w) => w.weekend) },
              ],
              mode: "grouped",
              yFmt: (v) => fmt.pp(v),
              ariaLabel: `${src.label} weekday and weekend averages by week`,
            }),
            tableView(["Week of", "Weekday avg (pp)", "Weekend day avg (pp)", "Weekend lighter by"], weeks.map((w) => [fmt.dayLabel(w.start), fmt.pp(w.weekday), fmt.pp(w.weekend), w.weekday > 0 ? `${Math.round((1 - w.weekend / w.weekday) * 100)}%` : "–"]), [false, true, true, true]),
          )
        : h("p", { class: "empty" }, "No full Monday–Sunday week of data yet."),
    ),
  );
  return root;
}

// ---------- boot ----------

applyTheme();
renderShell();
setInterval(() => {
  if (st.autoReload) location.reload();
}, 5 * 60 * 1000);

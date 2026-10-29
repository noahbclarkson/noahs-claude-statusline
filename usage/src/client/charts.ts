// Small SVG chart kit: a time-series line chart (crosshair + one tooltip for
// every series, keyboard navigable) and a column chart (per-column tooltip).
// Marks follow the dataviz specs: 2px lines, ≥8px ringed markers, 24px-max
// columns with 4px rounded tops and 2px surface gaps, hairline grid.

import { addDays, dayStart, isWeekend } from "../model/time";
import { h, icon } from "./dom";
import * as fmt from "./format";

const NS = "http://www.w3.org/2000/svg";
type Attrs = Record<string, string | number | undefined>;

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  parent?.appendChild(el);
  return el;
}

export interface XY {
  x: number;
  y: number;
}

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  points: XY[];
  dashed?: boolean;
  /** De-emphasised context line (gray, thinner, no marker). */
  muted?: boolean;
  /** Hold each value until the next point. */
  step?: boolean;
  band?: { x: number; lo: number; hi: number }[];
  legend?: boolean;
  tooltip?: boolean;
}

export interface LineChartSpec {
  series: LineSeries[];
  xKind: "time" | "days";
  xMin: number;
  xMax: number;
  yMax: number;
  yFmt: (v: number) => string;
  /** Tick label for "days" axes. */
  xFmt?: (x: number) => string;
  tipTitle?: (x: number) => string;
  refLines?: { y: number; label: string }[];
  now?: number;
  weekends?: boolean;
  height?: number;
  ariaLabel: string;
  /** Extra legend entries, e.g. the model range band. */
  legendExtra?: { label: string; kind: "band" | "line" | "dashed"; color: string }[];
}

const M = { l: 40, r: 14, t: 12, b: 26 };

function lineKey(color: string, dashed = false, muted = false): SVGSVGElement {
  const k = s("svg", { width: 18, height: 10, "aria-hidden": "true" });
  s("line", { x1: 1, y1: 5, x2: 17, y2: 5, "stroke-width": muted ? 1.5 : 2, "stroke-linecap": "round", "stroke-dasharray": dashed ? "4 3" : undefined }, k).style.stroke = color;
  return k;
}

function rectKey(color: string, opacity = 1): SVGSVGElement {
  const k = s("svg", { width: 12, height: 12, "aria-hidden": "true" });
  const r = s("rect", { x: 1, y: 1, width: 10, height: 10, rx: 2 }, k);
  r.style.fill = color;
  r.style.fillOpacity = String(opacity);
  return k;
}

export function legend(items: { label: string; node: SVGSVGElement }[]): HTMLElement {
  const el = h("div", { class: "legend" });
  for (const it of items) el.append(h("span", {}, it.node, it.label));
  return el;
}

function niceTicks(max: number): number[] {
  if (max <= 100 && max >= 60) return [0, 25, 50, 75, 100].filter((v) => v <= max);
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

function timeTicks(min: number, max: number, plotW: number): { ticks: number[]; label: (t: number) => string } {
  const span = max - min;
  const stepsH = [1, 2, 3, 6, 12, 24, 48, 168, 336, 672];
  const stepH = stepsH.find((st) => (plotW / span) * st * 3600 >= 70) ?? 672;
  const ticks: number[] = [];
  if (stepH < 24) {
    const st = stepH * 3600;
    for (let t = Math.ceil(min / st) * st; t <= max; t += st) ticks.push(t);
    return { ticks, label: (t) => (fmt.time(t) === "00:00" ? fmt.dayShort(t) : fmt.time(t)) };
  }
  const nDays = stepH / 24;
  let d = dayStart(min);
  if (d < min) d = addDays(d, 1);
  if (nDays >= 7) while (new Date(d * 1000).getDay() !== 1) d = addDays(d, 1);
  for (; d <= max; d = addDays(d, nDays)) ticks.push(d);
  return { ticks, label: nDays >= 7 ? fmt.date : fmt.dayShort };
}

function valueAt(se: LineSeries, x: number): number | null {
  const p = se.points;
  if (!p.length || x < p[0].x || x > p[p.length - 1].x) return null;
  let lo = 0;
  let hi = p.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p[mid].x <= x) lo = mid;
    else hi = mid - 1;
  }
  const a = p[lo];
  const b = p[lo + 1];
  if (se.step || !b || b.x === a.x) return a.y;
  return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
}

/** Renders now and re-renders whenever the container's width changes. */
function responsive(container: HTMLElement, draw: (width: number) => void): void {
  let last = -1;
  const run = () => {
    const w = Math.floor(container.clientWidth);
    if (w > 0 && w !== last) {
      last = w;
      draw(w);
    }
  };
  new ResizeObserver(run).observe(container);
  requestAnimationFrame(run);
}

export function lineChart(spec: LineChartSpec): HTMLElement {
  const wrap = h("div");
  const items: { label: string; node: SVGSVGElement }[] = [];
  const seen = new Set<string>();
  for (const se of spec.series) {
    if (se.legend === false || seen.has(se.label)) continue;
    seen.add(se.label);
    items.push({ label: se.label, node: lineKey(se.muted ? "var(--prior-line)" : se.color, se.dashed, se.muted) });
  }
  for (const ex of spec.legendExtra ?? []) items.push({ label: ex.label, node: ex.kind === "band" ? rectKey(ex.color, 0.18) : lineKey(ex.color, ex.kind === "dashed") });
  if (items.length > 1) wrap.append(legend(items));
  const box = h("div", { class: "chart" });
  wrap.append(box);
  responsive(box, (W) => drawLine(box, spec, W));
  return wrap;
}

function drawLine(box: HTMLElement, spec: LineChartSpec, W: number): void {
  box.replaceChildren();
  const H = spec.height ?? 260;
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;
  const X = (x: number) => M.l + ((x - spec.xMin) / (spec.xMax - spec.xMin)) * pw;
  const Y = (y: number) => M.t + ph - (Math.min(y, spec.yMax) / spec.yMax) * ph;
  const svg = s("svg", { width: W, height: H, role: "img", "aria-label": spec.ariaLabel, tabindex: 0 }, box);
  const clipId = `c${Math.random().toString(36).slice(2)}`;
  s("rect", { x: M.l, y: M.t - 2, width: pw, height: ph + 4 }, s("clipPath", { id: clipId }, s("defs", {}, svg)));

  if (spec.weekends && spec.xKind === "time") {
    for (let d = dayStart(spec.xMin); d < spec.xMax; d = addDays(d, 1)) {
      if (!isWeekend(d)) continue;
      const x0 = X(Math.max(d, spec.xMin));
      const x1 = X(Math.min(addDays(d, 1), spec.xMax));
      s("rect", { x: x0, y: M.t, width: Math.max(0, x1 - x0), height: ph }, svg).style.fill = "var(--weekend)";
    }
  }

  for (const v of niceTicks(spec.yMax)) {
    const y = Y(v);
    s("line", { x1: M.l, x2: M.l + pw, y1: y, y2: y, "stroke-width": 1, "shape-rendering": "crispEdges" }, svg).style.stroke = v === 0 ? "var(--axis)" : "var(--grid)";
    s("text", { x: M.l - 6, y: y + 3.5, "text-anchor": "end" }, svg).textContent = spec.yFmt(v);
  }

  if (spec.xKind === "time") {
    const { ticks, label } = timeTicks(spec.xMin, spec.xMax, pw);
    for (const t of ticks) s("text", { x: X(t), y: H - 8, "text-anchor": "middle" }, svg).textContent = label(t);
  } else {
    for (let x = Math.ceil(spec.xMin); x <= spec.xMax; x++) {
      if (pw / (spec.xMax - spec.xMin) < 38 && x % 2) continue;
      s("text", { x: X(x), y: H - 8, "text-anchor": "middle" }, svg).textContent = spec.xFmt ? spec.xFmt(x) : String(x);
    }
  }

  for (const r of spec.refLines ?? []) {
    if (r.y > spec.yMax) continue;
    const y = Y(r.y);
    s("line", { x1: M.l, x2: M.l + pw, y1: y, y2: y, "stroke-width": 1, "shape-rendering": "crispEdges" }, svg).style.stroke = "var(--text-2)";
    s("text", { x: M.l + pw - 2, y: y - 4, "text-anchor": "end", class: "ref-label" }, svg).textContent = r.label;
  }

  if (spec.now != null && spec.now > spec.xMin && spec.now < spec.xMax) {
    const x = X(spec.now);
    s("line", { x1: x, x2: x, y1: M.t, y2: M.t + ph, "stroke-width": 1, "shape-rendering": "crispEdges" }, svg).style.stroke = "var(--axis)";
    s("text", { x: x + 4, y: M.t + 9, class: "ref-label" }, svg).textContent = "now";
  }

  const plot = s("g", { "clip-path": `url(#${clipId})` }, svg);
  for (const se of spec.series) {
    if (!se.band?.length) continue;
    const top = se.band.map((b) => `${X(b.x)},${Y(b.hi)}`);
    const bottom = se.band.map((b) => `${X(b.x)},${Y(b.lo)}`).reverse();
    const p = s("path", { d: `M${top.join("L")}L${bottom.join("L")}Z` }, plot);
    p.style.fill = se.color;
    p.style.fillOpacity = "0.12";
  }
  // Muted context lines first, so the story lines sit on top.
  const order = [...spec.series].sort((a, b) => Number(!!b.muted) - Number(!!a.muted));
  for (const se of order) {
    if (se.points.length < 2) continue;
    let d = `M${X(se.points[0].x)},${Y(se.points[0].y)}`;
    for (let i = 1; i < se.points.length; i++) {
      const p = se.points[i];
      if (se.step) d += `H${X(p.x)}V${Y(p.y)}`;
      else d += `L${X(p.x)},${Y(p.y)}`;
    }
    const path = s("path", { d, fill: "none", "stroke-width": se.muted ? 1.5 : 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": se.dashed ? "5 4" : undefined }, plot);
    path.style.stroke = se.muted ? "var(--prior-line)" : se.color;
  }

  // Hover / focus layer
  const tip = h("div", { class: "tip", role: "status" });
  box.append(tip);
  const cross = s("line", { y1: M.t, y2: M.t + ph, "stroke-width": 1, visibility: "hidden" }, svg);
  cross.style.stroke = "var(--text-2)";
  const dots = s("g", {}, svg);
  const tipSeries = spec.series.filter((se) => se.tooltip !== false);
  const hit = s("rect", { x: M.l, y: M.t, width: pw, height: ph, fill: "transparent" }, svg);
  let cur: number | null = null;

  const show = (x: number) => {
    cur = Math.max(spec.xMin, Math.min(spec.xMax, x));
    const px = X(cur);
    cross.setAttribute("x1", String(px));
    cross.setAttribute("x2", String(px));
    cross.setAttribute("visibility", "visible");
    dots.replaceChildren();
    tip.replaceChildren(h("div", { class: "t-title" }, spec.tipTitle ? spec.tipTitle(cur) : fmt.dateTime(cur)));
    let rows = 0;
    for (const se of tipSeries) {
      const v = valueAt(se, cur);
      if (v == null) continue;
      rows++;
      const c = s("circle", { cx: px, cy: Y(v), r: 4, "stroke-width": 2 }, dots);
      c.style.fill = se.muted ? "var(--prior-line)" : se.color;
      c.style.stroke = "var(--surface)";
      tip.append(h("div", { class: "row" }, lineKey(se.muted ? "var(--prior-line)" : se.color, se.dashed, se.muted), h("b", {}, spec.yFmt(v)), h("span", {}, se.label)));
    }
    tip.style.display = rows ? "block" : "none";
    const tw = tip.offsetWidth;
    tip.style.left = `${px + 14 + tw > W ? Math.max(0, px - 14 - tw) : px + 14}px`;
    tip.style.top = `${M.t}px`;
  };
  const hide = () => {
    cur = null;
    cross.setAttribute("visibility", "hidden");
    dots.replaceChildren();
    tip.style.display = "none";
  };
  const toData = (ev: PointerEvent) => spec.xMin + ((ev.clientX - svg.getBoundingClientRect().left - M.l) / pw) * (spec.xMax - spec.xMin);
  hit.addEventListener("pointermove", (ev) => show(toData(ev)));
  hit.addEventListener("pointerleave", hide);
  svg.addEventListener("focus", () => show(spec.now ?? (spec.xMin + spec.xMax) / 2));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    const stepX = spec.xKind === "time" ? 3600 * (ev.shiftKey ? 24 : 1) : ev.shiftKey ? 1 : 1 / 24;
    show((cur ?? spec.now ?? spec.xMin) + (ev.key === "ArrowLeft" ? -stepX : stepX));
  });
}

export interface ColumnCat {
  label: string;
  title: string;
  forecast?: boolean;
  weekend?: boolean;
}

export interface ColumnSpec {
  cats: ColumnCat[];
  series: { key: string; label: string; color: string; values: number[]; opacity?: number; legend?: boolean }[];
  mode: "stacked" | "grouped";
  yFmt: (v: number) => string;
  height?: number;
  ariaLabel: string;
  forecastLegend?: boolean;
}

export function columnChart(spec: ColumnSpec): HTMLElement {
  const wrap = h("div");
  const items = spec.series.filter((se) => se.legend !== false).map((se) => ({ label: se.label, node: rectKey(se.color, se.opacity ?? 1) }));
  if (spec.forecastLegend) items.push({ label: "Forecast (lighter)", node: rectKey("var(--text-2)", 0.35) });
  if (items.length > 1) wrap.append(legend(items));
  const box = h("div", { class: "chart" });
  wrap.append(box);
  responsive(box, (W) => drawColumns(box, spec, W));
  return wrap;
}

function topRounded(x: number, y: number, w: number, hgt: number, r: number): string {
  r = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

function drawColumns(box: HTMLElement, spec: ColumnSpec, W: number): void {
  box.replaceChildren();
  const H = spec.height ?? 220;
  const n = spec.cats.length;
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;
  const totals = spec.cats.map((_, i) =>
    spec.mode === "stacked" ? spec.series.reduce((a, se) => a + (se.values[i] || 0), 0) : Math.max(0, ...spec.series.map((se) => se.values[i] || 0)),
  );
  const yMax = Math.max(1, ...totals) * 1.08;
  const ticks = niceTicks(yMax);
  const top = ticks[ticks.length - 1] >= yMax ? ticks[ticks.length - 1] : yMax;
  const Y = (v: number) => M.t + ph - (v / top) * ph;
  const band = pw / Math.max(1, n);
  const svg = s("svg", { width: W, height: H, role: "img", "aria-label": spec.ariaLabel }, box);

  spec.cats.forEach((c, i) => {
    if (c.weekend) s("rect", { x: M.l + i * band, y: M.t, width: band, height: ph }, svg).style.fill = "var(--weekend)";
  });
  for (const v of ticks) {
    const y = Y(v);
    s("line", { x1: M.l, x2: M.l + pw, y1: y, y2: y, "stroke-width": 1, "shape-rendering": "crispEdges" }, svg).style.stroke = v === 0 ? "var(--axis)" : "var(--grid)";
    s("text", { x: M.l - 6, y: y + 3.5, "text-anchor": "end" }, svg).textContent = spec.yFmt(v);
  }
  const every = Math.max(1, Math.ceil((n * 46) / pw));
  spec.cats.forEach((c, i) => {
    if (i % every) return;
    s("text", { x: M.l + (i + 0.5) * band, y: H - 8, "text-anchor": "middle" }, svg).textContent = c.label;
  });

  const tip = h("div", { class: "tip", role: "status" });
  box.append(tip);
  const k = spec.series.length;
  spec.cats.forEach((c, i) => {
    const g = s("g", {}, svg);
    const cx = M.l + (i + 0.5) * band;
    if (spec.mode === "stacked") {
      const bw = Math.min(24, band * 0.7);
      let base = 0;
      const segs = spec.series.map((se) => ({ se, v: se.values[i] || 0 })).filter((x) => x.v > 0);
      segs.forEach(({ se, v }, j) => {
        const y0 = Y(base);
        const y1 = Y(base + v);
        base += v;
        // Each segment above the first stops 2px short: a surface gap, not a stroke.
        const hgt = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));
        if (hgt <= 0) return;
        const d = j === segs.length - 1 ? topRounded(cx - bw / 2, y1, bw, hgt, 4) : `M${cx - bw / 2},${y1}h${bw}v${hgt}h${-bw}Z`;
        const p = s("path", { d }, g);
        p.style.fill = se.color;
        p.style.fillOpacity = String((se.opacity ?? 1) * (c.forecast ? 0.4 : 1));
      });
    } else {
      const bw = Math.min(24, (band * 0.8 - 2 * (k - 1)) / k);
      spec.series.forEach((se, j) => {
        const v = se.values[i] || 0;
        if (v <= 0) return;
        const x = cx - (k * bw + 2 * (k - 1)) / 2 + j * (bw + 2);
        const p = s("path", { d: topRounded(x, Y(v), bw, Y(0) - Y(v), 4) }, g);
        p.style.fill = se.color;
        p.style.fillOpacity = String((se.opacity ?? 1) * (c.forecast ? 0.4 : 1));
      });
    }
    const hitR = s("rect", { x: M.l + i * band, y: M.t, width: band, height: ph, fill: "transparent", tabindex: 0, "aria-label": c.title }, svg);
    const on = () => {
      hitR.style.fill = "var(--wash)";
      tip.replaceChildren(h("div", { class: "t-title" }, c.title + (c.forecast ? " · forecast" : "")));
      for (const se of spec.series) tip.append(h("div", { class: "row" }, rectKey(se.color, se.opacity ?? 1), h("b", {}, spec.yFmt(se.values[i] || 0)), h("span", {}, se.label)));
      if (spec.mode === "stacked" && k > 1) tip.append(h("div", { class: "row" }, h("b", {}, spec.yFmt(totals[i])), h("span", {}, "Total")));
      tip.style.display = "block";
      const tw = tip.offsetWidth;
      tip.style.left = `${cx + band / 2 + 8 + tw > W ? Math.max(0, cx - band / 2 - 8 - tw) : cx + band / 2 + 8}px`;
      tip.style.top = `${M.t}px`;
    };
    const off = () => {
      hitR.style.fill = "transparent";
      tip.style.display = "none";
    };
    hitR.addEventListener("pointerenter", on);
    hitR.addEventListener("pointerleave", off);
    hitR.addEventListener("focus", on);
    hitR.addEventListener("blur", off);
  });
}

/** A collapsible table view — every chart has one, so no value is hover-only. */
export function tableView(headers: string[], rows: (string | number)[][], numeric: boolean[] = []): HTMLElement {
  const thead = h("thead", {}, h("tr", {}, ...headers.map((t, i) => h("th", { class: numeric[i] ? "num" : undefined }, t))));
  const tbody = h("tbody", {}, ...rows.map((r) => h("tr", {}, ...r.map((v, i) => h("td", { class: numeric[i] ? "num" : undefined }, String(v))))));
  return h("details", { class: "tv disclosure" }, h("summary", {}, icon("chevron"), "Show as table"), h("div", { class: "table-wrap" }, h("table", {}, thead, tbody)));
}

export { lineKey, rectKey };

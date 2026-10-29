// DOM helpers shared by the charts and the controls.

type Kid = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, string>> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (v != null) el.setAttribute(k, v);
  for (const k of kids) if (k || k === "") el.append(k as Node | string);
  return el;
}

/** One stroke family for every icon: 16px grid, 1.6px round strokes. */
const ICONS = {
  chevron: '<path d="M4.5 6.25 8 9.75l3.5-3.5"/>',
  check: '<path d="m3.5 8.25 3 3 6-6.5" stroke-width="2"/>',
  minus: '<path d="M4 8h8"/>',
  plus: '<path d="M8 4v8M4 8h8"/>',
  system: '<rect x="2" y="2.75" width="12" height="8.5" rx="1.5"/><path d="M5.75 13.75h4.5M8 11.25v2.5"/>',
  sun: '<circle cx="8" cy="8" r="2.75"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05"/>',
  moon: '<path d="M13.25 9.75A5.5 5.5 0 0 1 6.25 2.75a5.5 5.5 0 1 0 7 7Z"/>',
  sliders: '<path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/>',
  reset: '<path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.78"/><path d="M2.75 2.75v3h3"/>',
  history: '<path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.78"/><path d="M2.75 2.75v3h3M8 5.25V8l2 1.5"/>',
  alert: '<circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 10.9v.1" stroke-width="1.8"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16): SVGSVGElement {
  const t = document.createElement("template");
  t.innerHTML = `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
  return t.content.firstElementChild as SVGSVGElement;
}

let seq = 0;
export const uid = (prefix: string): string => `${prefix}${++seq}`;

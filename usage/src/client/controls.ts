// Form controls: switch, select, stepper, slider, segmented control, button
// and field. Plain DOM, no framework. Each follows the WAI-ARIA pattern for its
// role, is fully keyboard operable, and keeps its own visual state, so changing
// a setting never needs the controls re-rendered.

import { type IconName, h, icon, uid } from "./dom";

export interface Control<T> {
  el: HTMLElement;
  set(v: T): void;
  setDisabled(disabled: boolean): void;
}

// ---------- Switch ----------

export function toggleSwitch(o: { label: string; checked: boolean; onChange: (v: boolean) => void; hideLabel?: boolean }): Control<boolean> {
  let on = o.checked;
  const btn = h("button", { type: "button", role: "switch", class: "switch-track", "aria-label": o.hideLabel ? o.label : undefined }, h("span", { class: "switch-thumb" }));
  // A <label> forwards clicks on its text to the button inside it.
  const el = o.hideLabel ? h("span", { class: "switch" }, btn) : h("label", { class: "switch" }, btn, h("span", { class: "switch-text" }, o.label));
  const render = () => btn.setAttribute("aria-checked", String(on));
  btn.addEventListener("click", () => {
    on = !on;
    render();
    o.onChange(on);
  });
  render();
  return {
    el,
    set: (v) => ((on = v), render()),
    setDisabled: (d) => {
      btn.disabled = d;
      el.classList.toggle("is-disabled", d);
    },
  };
}

// ---------- Select (button + listbox popover) ----------

export interface Option<T> {
  value: T;
  label: string;
  detail?: string;
}

export function select<T extends string>(o: { label: string; value: T; options: Option<T>[]; onChange: (v: T) => void; align?: "start" | "end" }): Control<T> {
  const id = uid("sel");
  let value = o.value;
  let active = 0;
  let open = false;

  const valueEl = h("span", { class: "select-value" });
  const trigger = h("button", { type: "button", class: "control select-trigger", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-controls": `${id}-list` }, valueEl, icon("chevron"));
  const list = h("div", { class: "select-pop", role: "listbox", id: `${id}-list`, tabindex: "-1", "aria-label": o.label });
  list.hidden = true;
  const opts = o.options.map((op, i) => {
    const row = h(
      "div",
      { class: "select-option", role: "option", id: `${id}-${i}` },
      icon("check"),
      h("span", { class: "option-text" }, h("span", { class: "option-label" }, op.label), op.detail ? h("span", { class: "option-detail" }, op.detail) : null),
    );
    row.addEventListener("pointermove", () => active !== i && setActive(i));
    row.addEventListener("click", () => choose(i));
    list.append(row);
    return row;
  });
  const el = h("div", { class: "select" }, trigger, list);

  const selectedIndex = () => Math.max(0, o.options.findIndex((x) => x.value === value));
  const render = () => {
    const cur = o.options[selectedIndex()];
    valueEl.textContent = cur.label;
    trigger.setAttribute("aria-label", `${o.label}: ${cur.label}`);
    opts.forEach((row, i) => row.setAttribute("aria-selected", String(i === selectedIndex())));
  };
  const setActive = (i: number) => {
    active = Math.max(0, Math.min(opts.length - 1, i));
    opts.forEach((row, j) => row.classList.toggle("is-active", j === active));
    list.setAttribute("aria-activedescendant", opts[active].id);
    opts[active].scrollIntoView({ block: "nearest" });
  };
  const outside = (ev: PointerEvent) => {
    if (!el.contains(ev.target as Node)) close(false);
  };
  const show = () => {
    if (open || trigger.disabled) return;
    open = true;
    el.classList.remove("up", "end");
    list.hidden = false;
    // Flip above or right-align when the popover would leave the viewport.
    // Fit the list to the room below the trigger, or above it when that is roomier.
    const t = trigger.getBoundingClientRect();
    const below = innerHeight - t.bottom - 16;
    const above = t.top - 16;
    list.style.maxHeight = "";
    const r = list.getBoundingClientRect();
    if (r.height > below && above > below) el.classList.add("up");
    list.style.maxHeight = `${Math.max(160, el.classList.contains("up") ? above : below)}px`;
    if (o.align === "end" || r.right > document.documentElement.clientWidth - 8) el.classList.add("end");
    trigger.setAttribute("aria-expanded", "true");
    setActive(selectedIndex());
    list.focus({ preventScroll: true });
    document.addEventListener("pointerdown", outside, true);
  };
  const close = (refocus = true) => {
    if (!open) return;
    open = false;
    list.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    list.removeAttribute("aria-activedescendant");
    document.removeEventListener("pointerdown", outside, true);
    if (refocus) trigger.focus();
  };
  const choose = (i: number) => {
    const next = o.options[i].value;
    const changed = next !== value;
    value = next;
    render();
    close();
    if (changed) o.onChange(value);
  };

  trigger.addEventListener("click", () => (open ? close() : show()));
  trigger.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      show();
    }
  });
  let typed = "";
  let typedAt = 0;
  list.addEventListener("keydown", (ev) => {
    switch (ev.key) {
      case "ArrowDown":
        setActive(active + 1);
        break;
      case "ArrowUp":
        setActive(active - 1);
        break;
      case "Home":
        setActive(0);
        break;
      case "End":
        setActive(opts.length - 1);
        break;
      case "Enter":
      case " ":
        choose(active);
        break;
      case "Escape":
        close();
        break;
      case "Tab":
        close(false);
        return;
      default: {
        if (ev.key.length !== 1 || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        const now = performance.now();
        typed = (now - typedAt > 700 ? "" : typed) + ev.key.toLowerCase();
        typedAt = now;
        const hit = o.options.findIndex((x) => x.label.toLowerCase().startsWith(typed));
        if (hit >= 0) setActive(hit);
        return;
      }
    }
    ev.preventDefault();
  });
  list.addEventListener("focusout", (ev) => {
    if (!el.contains(ev.relatedTarget as Node)) close(false);
  });

  render();
  return { el, set: (v) => ((value = v), render()), setDisabled: (d) => (trigger.disabled = d) };
}

// ---------- Stepper (spinbutton) ----------

export function stepper(o: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  step: number;
  unit?: string;
  /** Shown when the value is empty (nullable steppers fall back to it). */
  placeholder?: number;
  nullable?: boolean;
  onChange: (v: number | null) => void;
}): Control<number | null> {
  let value = o.value;
  const decimals = (String(o.step).split(".")[1] ?? "").length;
  const show = (v: number) => v.toFixed(decimals);
  const input = h("input", {
    class: "stepper-input",
    type: "text",
    inputmode: decimals ? "decimal" : "numeric",
    role: "spinbutton",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": o.label,
    "aria-valuemin": String(o.min),
    "aria-valuemax": String(o.max),
    placeholder: o.placeholder != null ? show(o.placeholder) : undefined,
  });
  input.style.width = `${Math.max(show(o.max).length, show(o.min).length, 1) + 0.6}ch`;
  const dec = h("button", { type: "button", class: "stepper-btn", tabindex: "-1", "aria-label": `Decrease ${o.label}` }, icon("minus"));
  const inc = h("button", { type: "button", class: "stepper-btn", tabindex: "-1", "aria-label": `Increase ${o.label}` }, icon("plus"));
  const fieldEl = h("span", { class: "stepper-field" }, input, o.unit ? h("span", { class: "stepper-unit", "aria-hidden": "true" }, o.unit) : null);
  fieldEl.addEventListener("pointerdown", (ev) => {
    if (ev.target !== input) {
      ev.preventDefault();
      input.focus();
    }
  });
  const el = h("div", { class: "control stepper" }, dec, fieldEl, inc);

  const snap = (v: number) => Math.min(o.max, Math.max(o.min, Number((Math.round((v - o.min) / o.step) * o.step + o.min).toFixed(decimals))));
  const render = () => {
    input.value = value == null ? "" : show(value);
    if (value == null) input.removeAttribute("aria-valuenow");
    else input.setAttribute("aria-valuenow", String(value));
    const text = value == null ? `not set${o.placeholder != null ? `, using ${show(o.placeholder)}${o.unit ?? ""}` : ""}` : `${show(value)}${o.unit ? ` ${o.unit}` : ""}`;
    input.setAttribute("aria-valuetext", text);
    const base = value ?? o.placeholder ?? o.min;
    dec.disabled = input.disabled || base <= o.min;
    inc.disabled = input.disabled || base >= o.max;
  };
  const commit = (v: number | null) => {
    const next = v == null ? (o.nullable ? null : value) : snap(v);
    const changed = next !== value;
    value = next;
    render();
    if (changed) o.onChange(value);
  };
  const nudge = (dir: number, times = 1) => commit((value ?? o.placeholder ?? o.min) + dir * o.step * times);
  /** null = empty field; undefined = unparseable. */
  const parse = (): number | null | undefined => {
    const t = input.value.trim().replace(",", ".").replace(/[^\d.\-]/g, "");
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  };
  const commitText = () => {
    const p = parse();
    if (p === undefined) render();
    else commit(p);
  };

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
      ev.preventDefault();
      nudge(ev.key === "ArrowUp" ? 1 : -1, ev.shiftKey ? 10 : 1);
    } else if (ev.key === "PageUp" || ev.key === "PageDown") {
      ev.preventDefault();
      nudge(ev.key === "PageUp" ? 1 : -1, 10);
    } else if (ev.key === "Enter") {
      commitText();
      input.select();
    } else if (ev.key === "Escape") {
      render();
      input.select();
    }
  });
  input.addEventListener("blur", commitText);
  input.addEventListener("focus", () => input.select());

  // Press and hold repeats; the input keeps focus.
  for (const [btn, dir] of [
    [dec, -1],
    [inc, 1],
  ] as const) {
    let timer = 0;
    const stop = () => {
      clearTimeout(timer);
      clearInterval(timer);
    };
    btn.addEventListener("pointerdown", (ev) => {
      if (btn.disabled || ev.button !== 0) return;
      ev.preventDefault();
      nudge(dir);
      timer = window.setTimeout(() => {
        timer = window.setInterval(() => (btn.disabled ? stop() : nudge(dir)), 70);
      }, 420);
    });
    for (const type of ["pointerup", "pointerleave", "pointercancel"]) btn.addEventListener(type, stop);
    // Clicks from assistive tech arrive without a pointer.
    btn.addEventListener("click", (ev) => ev.detail === 0 && nudge(dir));
  }

  render();
  return {
    el,
    set: (v) => ((value = v), render()),
    setDisabled: (d) => {
      input.disabled = d;
      el.classList.toggle("is-disabled", d);
      render();
    },
  };
}

// ---------- Slider ----------

export function slider(o: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onInput: (v: number) => void }): Control<number> {
  const input = h("input", { type: "range", class: "range", min: String(o.min), max: String(o.max), step: String(o.step), "aria-label": o.label });
  input.value = String(o.value);
  const out = h("output", { class: "slider-value", "aria-hidden": "true" });
  const el = h("div", { class: "slider" }, input, out);
  const render = () => {
    const v = Number(input.value);
    out.textContent = o.format(v);
    input.setAttribute("aria-valuetext", o.format(v));
    input.style.setProperty("--fill", `${((v - o.min) / (o.max - o.min)) * 100}%`);
  };
  input.addEventListener("input", () => {
    render();
    o.onInput(Number(input.value));
  });
  render();
  return {
    el,
    set: (v) => ((input.value = String(v)), render()),
    setDisabled: (d) => {
      input.disabled = d;
      el.classList.toggle("is-disabled", d);
    },
  };
}

// ---------- Segmented control (radio group) ----------

export function segmented<T extends string | number>(o: {
  label: string;
  value: T;
  options: { value: T; label: string; icon?: IconName }[];
  onChange: (v: T) => void;
  iconOnly?: boolean;
}): Control<T> {
  let value = o.value;
  const el = h("div", { class: `segmented${o.iconOnly ? " icon-only" : ""}`, role: "radiogroup", "aria-label": o.label });
  const btns = o.options.map((op) => {
    const b = h(
      "button",
      { type: "button", role: "radio", class: "segment", "aria-label": o.iconOnly ? op.label : undefined, title: o.iconOnly ? op.label : undefined },
      op.icon ? icon(op.icon) : null,
      o.iconOnly ? null : h("span", {}, op.label),
    );
    b.addEventListener("click", () => pick(op.value, false));
    el.append(b);
    return b;
  });
  const render = () =>
    btns.forEach((b, i) => {
      const on = o.options[i].value === value;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  const pick = (v: T, focus: boolean) => {
    const changed = v !== value;
    value = v;
    render();
    if (focus) btns[o.options.findIndex((x) => x.value === v)].focus();
    if (changed) o.onChange(v);
  };
  // Radio groups move the selection with the arrow keys.
  el.addEventListener("keydown", (ev) => {
    const n = o.options.length;
    const i = o.options.findIndex((x) => x.value === value);
    const j = ({ ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1 + n, ArrowUp: i - 1 + n, Home: 0, End: n - 1 } as Record<string, number>)[ev.key];
    if (j === undefined) return;
    ev.preventDefault();
    pick(o.options[j % n].value, true);
  });
  render();
  return { el, set: (v) => ((value = v), render()), setDisabled: (d) => btns.forEach((b) => (b.disabled = d)) };
}

// ---------- Button ----------

export function button(
  label: string,
  onClick: () => void,
  o: { variant?: "primary" | "secondary" | "ghost"; size?: "sm"; icon?: IconName; disabled?: boolean; title?: string } = {},
): HTMLButtonElement {
  const b = h(
    "button",
    { type: "button", class: `btn btn-${o.variant ?? "secondary"}${o.size ? ` btn-${o.size}` : ""}`, title: o.title },
    o.icon ? icon(o.icon) : null,
    h("span", {}, label),
  );
  b.disabled = !!o.disabled;
  b.addEventListener("click", onClick);
  return b;
}

// ---------- Field ----------

/** A label above one or more controls, with optional help text below. */
export function field(label: string, controls: Node | Node[], help?: string): HTMLElement {
  const id = uid("fl");
  return h(
    "div",
    { class: "field", role: "group", "aria-labelledby": id },
    h("span", { class: "field-label", id }, label),
    h("div", { class: "field-control" }, ...[controls].flat()),
    help ? h("p", { class: "field-help" }, help) : null,
  );
}

/** A small inline caption that sits beside a control inside a field. */
export const caption = (...kids: (Node | string)[]): HTMLElement => h("span", { class: "caption" }, ...kids);

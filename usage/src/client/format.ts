// Display formatting. All dates are local time.

const dtf = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-NZ", o);
const fDay = dtf({ weekday: "short", day: "numeric", month: "short" });
const fDayShort = dtf({ weekday: "short", day: "numeric" });
const fTime = dtf({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fDate = dtf({ day: "numeric", month: "short" });
const fWeekday = dtf({ weekday: "short" });

const d = (t: number) => new Date(t * 1000);

export const pct = (v: number): string => `${Math.round(v)}%`;
export const pp = (v: number): string => (Math.abs(v) < 10 && !Number.isInteger(v) ? v.toFixed(1) : String(Math.round(v)));
export const dayLabel = (t: number): string => fDay.format(d(t));
export const dayShort = (t: number): string => fDayShort.format(d(t));
export const time = (t: number): string => fTime.format(d(t));
export const date = (t: number): string => fDate.format(d(t));
export const weekday = (t: number): string => fWeekday.format(d(t));
export const dateTime = (t: number): string => `${fDay.format(d(t))}, ${fTime.format(d(t))}`;
export const weekdayTime = (t: number): string => `${fWeekday.format(d(t))} ${fTime.format(d(t))}`;

/** "2d 4h", "5h 10m", "12m". */
export function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Signed percentage change for a pace multiplier, e.g. 1.23 → "+23%". */
export function change(mult: number): string {
  if (!Number.isFinite(mult)) return "+900%+";
  const v = Math.round((mult - 1) * 100);
  return `${v >= 0 ? "+" : "−"}${Math.abs(v)}%`;
}

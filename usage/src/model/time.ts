// Time helpers. Everything is epoch seconds; calendar maths (days, weekends,
// hour of day) uses the local time zone, so DST days are 23 or 25 hours long.

export const HOUR = 3600;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

export const hourIndex = (t: number): number => Math.floor(t / HOUR);

/** Local midnight of the day containing t. */
export function dayStart(t: number): number {
  const d = new Date(t * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

/** Local midnight n calendar days after the local midnight `day`. */
export function addDays(day: number, n: number): number {
  const d = new Date(day * 1000);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

/** 0 = Sunday … 6 = Saturday. */
export const dayOfWeek = (t: number): number => new Date(t * 1000).getDay();
export const hourOfDay = (t: number): number => new Date(t * 1000).getHours();
export const isWeekendDow = (dow: number): boolean => dow === 0 || dow === 6;
export const isWeekend = (t: number): boolean => isWeekendDow(dayOfWeek(t));

/** Local Monday 00:00 of the calendar week containing t. */
export function mondayOf(t: number): number {
  const d = dayStart(t);
  return addDays(d, -((dayOfWeek(d) + 6) % 7));
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

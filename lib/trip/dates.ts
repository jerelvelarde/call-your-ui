/** UTC date math on "YYYY-MM-DD" strings. No time zones: a trip day is a calendar date. */
import type { Weekday } from "./types";

export const WEEKDAYS: readonly Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const BY_UTC_DAY: readonly Weekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(iso: string): Date {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${iso}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** True for a real calendar date in "YYYY-MM-DD" form. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  return parse(value).toISOString().slice(0, 10) === value;
}

export function weekdayOf(iso: string): Weekday {
  return BY_UTC_DAY[parse(iso).getUTCDay()];
}

export function addDays(iso: string, n: number): string {
  const d = parse(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Fri 11 Dec". */
export function formatShort(iso: string): string {
  const d = parse(iso);
  return `${weekdayOf(iso)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The weekday `n` days from `weekday` (negative goes back). */
export function shiftWeekday(weekday: Weekday, n: number): Weekday {
  const i = WEEKDAYS.indexOf(weekday);
  return WEEKDAYS[(((i + n) % 7) + 7) % 7];
}

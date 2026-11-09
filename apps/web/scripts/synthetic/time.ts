/**
 * Calendar helpers for historical, practice-local events.
 *
 * Clinic events happen at local wall-clock times (an 09:30 appointment in the
 * practice's timezone), but PostgreSQL stores `timestamptz` instants. These
 * helpers convert explicitly, including across daylight-saving changes, so no
 * historical event silently falls back to the server's clock or `now()`.
 */

export type CalendarDate = string; // YYYY-MM-DD

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: string): value is CalendarDate {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(later: CalendarDate, earlier: CalendarDate): number {
  return Math.round(
    (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000,
  );
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(date: CalendarDate): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function eachDate(start: CalendarDate, end: CalendarDate): CalendarDate[] {
  const out: CalendarDate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export function monthKey(date: CalendarDate): string {
  return date.slice(0, 7);
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetMinutesAt(instant: Date, timeZone: string): number {
  let formatter = offsetFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** Convert a practice-local wall-clock time to the UTC instant it denotes. */
export function localToUtc(
  date: CalendarDate,
  minutesAfterMidnight: number,
  timeZone: string,
): Date {
  const hours = Math.floor(minutesAfterMidnight / 60);
  const minutes = minutesAfterMidnight % 60;
  const naive = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    hours,
    minutes,
  );
  // Two passes settle the offset on either side of a DST transition.
  let guess = naive - offsetMinutesAt(new Date(naive), timeZone) * 60_000;
  guess = naive - offsetMinutesAt(new Date(guess), timeZone) * 60_000;
  return new Date(guess);
}

// Intl formatters allocate native (ICU) memory that the JS heap limit does not
// see; constructing one per call exhausts memory on multi-year datasets.
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** Practice-local calendar date of an instant. */
export function localDateOf(instant: Date, timeZone: string): CalendarDate {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter.format(instant);
}

/** Practice-local YYYY-MM of an instant. */
export function localMonthOf(instant: Date, timeZone: string): string {
  return localDateOf(instant, timeZone).slice(0, 7);
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

/** US clinic closures used by the default calendar (fixed + Thanksgiving). */
export function isClinicHoliday(date: CalendarDate): boolean {
  const md = date.slice(5);
  if (md === "01-01" || md === "07-04" || md === "12-25") return true;
  // Thanksgiving: fourth Thursday of November.
  if (date.slice(5, 7) === "11" && dayOfWeek(date) === 4) {
    const day = Number(date.slice(8, 10));
    if (day >= 22 && day <= 28) return true;
  }
  return false;
}

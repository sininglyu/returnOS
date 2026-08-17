// Single source of truth for deadline math. All dates stored as UTC
// (CLAUDE.md "Conventions") — never do this arithmetic inline elsewhere.

// Adds `days` (may be negative) to `date` using UTC calendar math, so it's
// unaffected by the host's local timezone/DST. Used for order date -> return
// deadline math (lib/parse.ts, prisma/seed.ts).
export function addDaysUTC(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

// Whole-day difference between two UTC calendar dates - same UTC-midnight
// approach as addDaysUTC, so both share one notion of "a day". Positive =
// days left, 0 = last day, negative = window passed. Used by item 5's
// purchases list (sort + display label) and item 7's cron "N days out" scan.
export function daysRemainingUTC(deadline: Date, from: Date): number {
  const d = Date.UTC(
    deadline.getUTCFullYear(),
    deadline.getUTCMonth(),
    deadline.getUTCDate(),
  );
  const f = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
  );
  return Math.round((d - f) / 86_400_000);
}

// UTC-midnight of the given date's calendar day - the boundary item 7's
// cron scan needs, expressed with the same UTC-midnight approach as
// addDaysUTC/daysRemainingUTC rather than inline date math in lib/reminders.ts.
export function startOfUTCDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// Human-readable "Mon D" label, read in UTC rather than the host's local
// timezone - matches addDaysUTC/daysRemainingUTC's UTC-midnight convention
// instead of quietly introducing a second notion of "the date" for display.
// Used by app/purchases-list.tsx (order date, resolved date).
export function formatDateUTC(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

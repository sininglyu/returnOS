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

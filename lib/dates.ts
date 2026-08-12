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

// TODO(item 7): used by the daily cron's "N days out" scan (7-day and
// 2-day reminders per CLAUDE.md V1 scope).
export function daysRemainingUTC(_deadline: Date, _from: Date): number {
  throw new Error("not implemented");
}

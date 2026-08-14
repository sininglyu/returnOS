// Item 7: scan RETURNABLE purchases for the 7-day/2-day reminder
// thresholds and send via lib/email.ts. Business logic lives here, not in
// the route handler (CLAUDE.md convention) - app/api/cron/reminders/route.ts
// stays thin: auth check, call this, format the response.
//
// IMPORTANT: never log email content - purchaseId, daysBefore, error
// types only, same discipline as lib/parse.ts / lib/gmail.ts.

import { prisma } from "./db";
import { addDaysUTC, daysRemainingUTC, startOfUTCDay } from "./dates";
import { sendReminderEmail } from "./email";

// Descending; these are the Reminder.daysBefore values.
const THRESHOLDS = [7, 2] as const;

export interface ReminderRunSummary {
  scanned: number; // purchases the DB query returned
  sent: number; // purchases that got an email this run (1/purchase, not 1/threshold)
  skippedAlreadySent: number; // had due thresholds, but all already recorded
  failed: number; // send threw; no Reminder row written, retried next run
}

export async function processDueReminders(
  now: Date = new Date(),
): Promise<ReminderRunSummary> {
  // A reminder only fires while the window is still open. A deadline that
  // has already fully passed gets no catch-up reminder even if a
  // threshold was never sent - matches item 5's UI, which already treats
  // a passed deadline as "return window passed," nothing left to act on.
  const start = startOfUTCDay(now);
  const endExclusive = addDaysUTC(start, Math.max(...THRESHOLDS) + 1);

  const candidates = await prisma.purchase.findMany({
    where: {
      status: "RETURNABLE",
      returnDeadline: { gte: start, lt: endExclusive },
    },
    include: {
      user: { select: { email: true } },
      reminders: { select: { daysBefore: true } },
    },
  });

  const summary: ReminderRunSummary = {
    scanned: candidates.length,
    sent: 0,
    skippedAlreadySent: 0,
    failed: 0,
  };

  // Sequential, not Promise.all'd - V1 volume is tiny and this is gentler
  // on SMTP rate limits than fanning out. /api/sync's bounded-concurrency
  // chunking is the pattern to reach for if volume ever grows.
  for (const purchase of candidates) {
    // returnDeadline can't be null here (filtered by the query above),
    // but the field is nullable on the model.
    if (!purchase.returnDeadline) continue;

    const daysRemaining = daysRemainingUTC(purchase.returnDeadline, now);
    const due = THRESHOLDS.filter((t) => daysRemaining <= t);
    if (due.length === 0) continue;

    const alreadySent = new Set(purchase.reminders.map((r) => r.daysBefore));
    const unsent = due.filter((t) => !alreadySent.has(t));
    if (unsent.length === 0) {
      summary.skippedAlreadySent++;
      continue;
    }

    try {
      await sendReminderEmail({
        to: purchase.user.email,
        itemName: purchase.itemName,
        retailer: purchase.retailer,
        daysRemaining,
      });
    } catch (err) {
      console.log("reminders: send failed", {
        purchaseId: purchase.id,
        daysBefore: Math.min(...unsent),
        errorType: err instanceof Error ? err.name : typeof err,
      });
      summary.failed++;
      continue;
    }

    summary.sent++;
    // Record all due thresholds, not just the emailed one - stops a
    // stale 7-day reminder firing tomorrow for a purchase that already
    // got its 2-day one. skipDuplicates + the @@unique([purchaseId,
    // daysBefore]) constraint make a concurrent/overlapping run idempotent.
    await prisma.reminder.createMany({
      data: due.map((daysBefore) => ({ purchaseId: purchase.id, daysBefore })),
      skipDuplicates: true,
    });
    console.log("reminders: sent", {
      purchaseId: purchase.id,
      thresholdsRecorded: due,
    });
  }

  return summary;
}

// Purchases query for the signed-in user (item 5). Kept in lib/ per the
// "server-side logic lives in lib/" convention - item 7's cron will reuse
// a purchases query too.

import { prisma } from "./db";
import type { Purchase } from "@prisma/client";

// Sort by status first, then deadline - NOT deadline alone. A plain
// ascending sort on returnDeadline puts old RETURNED/EXPIRED/KEEPING rows
// (large negative days-remaining) ahead of an actionable RETURNABLE row
// with 2 days left, defeating "urgent ones surface first". Confirmed
// against the live DB (pg_enum) that RETURNABLE is enumsortorder 1, so
// `status asc` alone already puts every actionable row before the
// resolved ones; `returnDeadline asc nulls last` then orders within that
// group by urgency, with unknown-policy rows last.
export function getPurchasesForUser(userId: string): Promise<Purchase[]> {
  return prisma.purchase.findMany({
    where: { userId },
    orderBy: [
      { status: "asc" },
      { returnDeadline: { sort: "asc", nulls: "last" } },
    ],
  });
}

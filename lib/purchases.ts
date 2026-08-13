// Purchases query for the signed-in user (item 5). Kept in lib/ per the
// "server-side logic lives in lib/" convention - item 7's cron will reuse
// a purchases query too.

import { prisma } from "./db";
import type { Purchase, PurchaseStatus } from "@prisma/client";

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

// Item 6: mark a purchase RETURNED or KEEPING. Deliberately narrower than
// the full PurchaseStatus union - RETURNABLE is the creation default and
// EXPIRED is item 7's cron comparing deadline to now; neither is a
// user-facing choice through this path. `updateMany` with { id, userId }
// in the where clause does the ownership check and the update in one
// query - no separate find-then-check race window, and a wrong/foreign id
// just yields count 0 (mapped to 404 by the route), no existence leak.
export async function updatePurchaseStatus(
  userId: string,
  purchaseId: string,
  status: Extract<PurchaseStatus, "RETURNED" | "KEEPING">,
): Promise<boolean> {
  const result = await prisma.purchase.updateMany({
    where: { id: purchaseId, userId },
    data: { status },
  });
  return result.count > 0;
}

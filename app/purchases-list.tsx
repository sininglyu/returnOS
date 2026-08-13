// V1 item 5: read-only purchases list, sorted so urgent returns surface
// first (see lib/purchases.ts for why status-then-deadline, not deadline
// alone). Async server component - Purchase.price (a Prisma Decimal) is
// formatted here and never crosses a serialization boundary to a client
// component. No mutation controls (mark as returned/keeping is item 6).

import { getPurchasesForUser } from "@/lib/purchases";
import { daysRemainingUTC } from "@/lib/dates";
import { PurchaseActions } from "./purchase-actions";
import type { Purchase } from "@prisma/client";

function formatPrice(purchase: Purchase): string | null {
  if (purchase.price === null) return null;
  const amount = purchase.price.toFixed(2);
  return purchase.currency ? `${purchase.currency} ${amount}` : amount;
}

// Presentation-only label - never mutates or contradicts the stored
// status. A RETURNABLE row past its deadline is labeled accurately here
// without lying about the DB status; the cron that actually flips such
// rows to EXPIRED is item 7, not built yet.
function statusLabel(purchase: Purchase, now: Date): string {
  if (purchase.status !== "RETURNABLE") {
    return purchase.status;
  }
  if (!purchase.returnDeadline) return "policy unknown";

  const daysRemaining = daysRemainingUTC(purchase.returnDeadline, now);
  if (daysRemaining < 0) return "return window passed";
  if (daysRemaining === 0) return "last day";
  return `${daysRemaining} days left`;
}

// Same urgency thresholds item 7's reminder cron will use (7-day, 2-day) -
// meaningful, not decorative. Only applies to RETURNABLE rows with a
// future deadline; every other case falls through to the default color.
function urgencyClass(purchase: Purchase, now: Date): string {
  if (purchase.status !== "RETURNABLE" || !purchase.returnDeadline) {
    return "text-gray-500";
  }
  const daysRemaining = daysRemainingUTC(purchase.returnDeadline, now);
  if (daysRemaining < 0) return "text-gray-500";
  if (daysRemaining <= 2) return "text-red-600";
  if (daysRemaining <= 7) return "text-amber-600";
  return "text-gray-500";
}

export async function PurchasesList({ userId }: { userId: string }) {
  const purchases = await getPurchasesForUser(userId);
  const now = new Date();

  if (purchases.length === 0) {
    return <p className="text-sm text-gray-500">No purchases yet — click Sync now.</p>;
  }

  return (
    <ul className="flex w-full flex-col gap-3">
      {purchases.map((purchase) => {
        const price = formatPrice(purchase);
        return (
          <li
            key={purchase.id}
            className="flex items-center justify-between gap-4 border-b border-gray-200 pb-3"
          >
            <div className="flex flex-col">
              <span className="font-medium">{purchase.itemName}</span>
              <span className="text-sm text-gray-500">
                {purchase.retailer}
                {price ? ` · ${price}` : ""}
              </span>
            </div>
            <div className="flex flex-col items-end">
              <span className={`text-sm ${urgencyClass(purchase, now)}`}>
                {statusLabel(purchase, now)}
              </span>
              <span className="text-xs uppercase text-gray-400">
                {purchase.status}
              </span>
              <PurchaseActions purchaseId={purchase.id} status={purchase.status} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

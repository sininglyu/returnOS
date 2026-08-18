// V1 item 5: purchases list, grouped by urgency so the most actionable
// returns surface first (see lib/purchases.ts for why the base sort is
// status-then-deadline, not deadline alone). Async server component -
// Purchase.price (a Prisma Decimal) is formatted here and never crosses a
// serialization boundary to a client component. Mutation (mark
// returned/keeping) lives in the colocated client leaf,
// app/purchase-actions.tsx (item 6) - unchanged here, only restyled.

import type { ReactNode } from "react";
import { getPurchasesForUser } from "@/lib/purchases";
import { daysRemainingUTC, formatDateUTC } from "@/lib/dates";
import { PurchaseActions } from "./purchase-actions";
import type { Purchase } from "@prisma/client";

// "resolved" covers RETURNED/KEEPING/EXPIRED alike - toneFor/statusLabel
// below split them back out for display. "passed" is distinct from
// "resolved": still RETURNABLE, deadline already gone, but item 7's cron
// (which flips it to EXPIRED) hasn't run yet - see app/purchases-list.tsx's
// prior read-only version, same "don't lie about the stored status" rule.
type Bucket = "urgent" | "soon" | "later" | "passed" | "unknown" | "resolved";

const SECTIONS: { bucket: Bucket; title: string; dotClass: string }[] = [
  { bucket: "urgent", title: "Act now", dotClass: "bg-crit" },
  { bucket: "soon", title: "This week", dotClass: "bg-warn-line" },
  { bucket: "later", title: "Plenty of time", dotClass: "bg-ink-3" },
  { bucket: "passed", title: "Window passed", dotClass: "bg-border-strong" },
  { bucket: "unknown", title: "Policy unknown", dotClass: "bg-border-strong" },
  { bucket: "resolved", title: "Resolved", dotClass: "bg-safe" },
];

// Same 7-day/2-day thresholds item 7's reminder cron uses (lib/reminders.ts)
// - meaningful, not decorative.
function bucketFor(purchase: Purchase, now: Date): Bucket {
  if (purchase.status !== "RETURNABLE") return "resolved";
  if (!purchase.returnDeadline) return "unknown";
  const daysRemaining = daysRemainingUTC(purchase.returnDeadline, now);
  if (daysRemaining < 0) return "passed";
  if (daysRemaining <= 2) return "urgent";
  if (daysRemaining <= 7) return "soon";
  return "later";
}

function groupByBucket(purchases: Purchase[], now: Date): Record<Bucket, Purchase[]> {
  const grouped: Record<Bucket, Purchase[]> = {
    urgent: [],
    soon: [],
    later: [],
    passed: [],
    unknown: [],
    resolved: [],
  };
  for (const purchase of purchases) {
    grouped[bucketFor(purchase, now)].push(purchase);
  }
  return grouped;
}

function statusLabel(purchase: Purchase, now: Date): string {
  if (purchase.status === "RETURNED") return `Returned ${formatDateUTC(purchase.updatedAt)}`;
  if (purchase.status === "KEEPING") return `Keeping — marked ${formatDateUTC(purchase.updatedAt)}`;
  if (purchase.status === "EXPIRED") return "Expired";
  if (!purchase.returnDeadline) return "No return policy on file";

  const daysRemaining = daysRemainingUTC(purchase.returnDeadline, now);
  if (daysRemaining < 0) return "Return window passed";
  if (daysRemaining === 0) return "Last day";
  return `${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left`;
}

type ChipTone = "crit" | "warn" | "calm" | "unknown" | "resolved" | "neutral" | "muted";

function toneFor(purchase: Purchase, bucket: Bucket): ChipTone {
  if (bucket === "resolved") {
    if (purchase.status === "RETURNED") return "resolved";
    if (purchase.status === "KEEPING") return "neutral";
    return "muted"; // EXPIRED
  }
  if (bucket === "urgent") return "crit";
  if (bucket === "soon") return "warn";
  if (bucket === "unknown") return "unknown";
  return "calm"; // later, passed
}

const CHIP_CLASSES: Record<ChipTone, string> = {
  crit: "bg-crit-bg text-crit",
  warn: "bg-warn-bg text-warn",
  calm: "border border-border bg-surface-2 text-ink-2",
  unknown: "border border-dashed border-border-strong text-ink-2",
  resolved: "bg-safe-bg text-safe",
  neutral: "border border-border bg-surface-2 text-ink-2",
  muted: "border border-border bg-surface-2 text-ink-3",
};

const CHIP_DOT: Partial<Record<ChipTone, string>> = {
  crit: "bg-crit",
  warn: "bg-warn",
  resolved: "bg-safe",
};

function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  const dot = CHIP_DOT[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 font-mono text-xs font-semibold tabular-nums ${CHIP_CLASSES[tone]}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />}
      {children}
    </span>
  );
}

function formatPrice(purchase: Purchase): string | null {
  if (purchase.price === null) return null;
  const amount = purchase.price.toFixed(2);
  return purchase.currency ? `${purchase.currency} ${amount}` : amount;
}

// Assumes USD - every real price synced on this account so far has been
// USD. A genuinely multi-currency inbox would need per-currency subtotals
// here instead of one summed number.
function sumPrice(items: Purchase[]): number {
  return items.reduce((sum, p) => sum + (p.price ? p.price.toNumber() : 0), 0);
}

function formatMoney(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Row({ purchase, bucket, now }: { purchase: Purchase; bucket: Bucket; now: Date }) {
  const price = formatPrice(purchase);
  const tone = toneFor(purchase, bucket);
  const stripeClass =
    bucket === "urgent" ? "bg-crit-line" : bucket === "soon" ? "bg-warn-line" : "bg-transparent";
  const isReturned = purchase.status === "RETURNED";

  return (
    <li className="flex items-stretch border-t border-border first:border-t-0">
      <span className={`w-[3px] shrink-0 ${stripeClass}`} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3.5 pl-3.5 pr-4">
        <div className="min-w-0">
          <p
            className={`truncate text-[14.5px] font-semibold ${
              purchase.status === "RETURNABLE" ? "text-foreground" : "text-ink-2"
            }`}
          >
            {isReturned ? (
              <span className="line-through decoration-ink-3">{purchase.itemName}</span>
            ) : (
              purchase.itemName
            )}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
            <span className="font-semibold">{purchase.retailer}</span>
            <span className="h-0.5 w-0.5 rounded-full bg-ink-3" aria-hidden="true" />
            <span>Ordered {formatDateUTC(purchase.orderDate)}</span>
            {purchase.orderNumber && (
              <>
                <span className="h-0.5 w-0.5 rounded-full bg-ink-3" aria-hidden="true" />
                <span className="font-mono text-[11px] tabular-nums text-ink-3">
                  #{purchase.orderNumber}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-4">
          {price && (
            <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
              {price}
            </span>
          )}
          <div className="flex flex-col items-end gap-1.5">
            <Chip tone={tone}>{statusLabel(purchase, now)}</Chip>
            <PurchaseActions purchaseId={purchase.id} status={purchase.status} />
          </div>
        </div>
      </div>
    </li>
  );
}

export async function PurchasesList({ userId }: { userId: string }) {
  const purchases = await getPurchasesForUser(userId);
  const now = new Date();

  if (purchases.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border-strong bg-surface p-8 text-center text-sm text-ink-2">
        No purchases yet — click Sync now.
      </div>
    );
  }

  const grouped = groupByBucket(purchases, now);
  // Still-open RETURNABLE rows: a deadline still ahead, or no policy on
  // file yet (so still actionable) - excludes "passed" (window's already
  // closed, nothing left to reclaim) and "resolved".
  const openPurchases = (["urgent", "soon", "later", "unknown"] as const).flatMap(
    (bucket) => grouped[bucket],
  );
  const refundableTotal = sumPrice(openPurchases);
  const urgentValue = sumPrice(grouped.urgent);

  const sections = SECTIONS.map((section) => ({ ...section, items: grouped[section.bucket] })).filter(
    (section) => section.items.length > 0,
  );

  return (
    <div className="flex flex-col gap-7">
      {openPurchases.length > 0 && (
        <div className="grid grid-cols-2 divide-x divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
          <div className="p-4">
            <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Refundable if you act
            </p>
            <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-foreground">
              {formatMoney(refundableTotal)}
            </p>
            <p className="mt-0.5 text-xs text-ink-2">
              across {openPurchases.length} open return{openPurchases.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="p-4">
            <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Closing in 48h
            </p>
            <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-foreground">
              {grouped.urgent.length}{" "}
              <span className="text-sm font-medium text-ink-3">
                item{grouped.urgent.length === 1 ? "" : "s"}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-ink-2">{formatMoney(urgentValue)} at stake</p>
          </div>
        </div>
      )}

      {sections.map(({ bucket, title, dotClass, items }) => (
        <section key={bucket}>
          <div className="mb-2.5 flex items-center gap-2.5 px-1">
            <span className={`h-2 w-2 shrink-0 rounded-sm ${dotClass}`} aria-hidden="true" />
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-ink-2">{title}</h2>
            <span className="font-mono text-[11px] tabular-nums text-ink-3">{items.length}</span>
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
          </div>
          <ul className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            {items.map((purchase) => (
              <Row key={purchase.id} purchase={purchase} bucket={bucket} now={now} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

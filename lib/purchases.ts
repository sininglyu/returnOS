// Purchases query for the signed-in user (item 5). Kept in lib/ per the
// "server-side logic lives in lib/" convention - item 7's cron will reuse
// a purchases query too.

import { prisma } from "./db";
import { Prisma } from "@prisma/client";
import type { Purchase, PurchaseStatus } from "@prisma/client";
import type { PurchaseResult } from "./schemas";

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

// --- Duplicate-order dedup/merge (see prisma/schema.prisma's second
// unique constraint, @@unique([userId, orderNumber])) ---
//
// A single real order sends multiple Gmail messages (confirmation,
// shipped, delivered, ...), each with its own gmailMessageId. Tier 2
// (lib/openai.ts) is meant to skip anything but the confirmation, but
// doesn't always - so gmailMessageId-only dedup let the same order create
// several Purchase rows. orderNumber identifies the real-world order;
// when present, it's the stronger idempotency key.

// The subset of a Purchase row's fields the merge policy below actually
// reasons about, expressed in plain JS types (not Prisma's Decimal/
// JsonValue) so mergePurchaseData is pure and reusable by both the live
// sync path and scripts/dedupe-purchases.ts's transaction-folded cleanup.
export interface PurchaseMergeState {
  retailer: string;
  itemName: string;
  orderNumber: string | null;
  orderDate: Date;
  price: number | null;
  currency: string | null;
  returnDeadline: Date | null;
  rawParseJson: Prisma.InputJsonValue;
}

function toMergeState(result: PurchaseResult): PurchaseMergeState {
  return {
    retailer: result.retailer,
    itemName: result.itemName,
    orderNumber: result.orderNumber,
    orderDate: new Date(result.orderDate),
    price: result.price,
    currency: result.currency,
    returnDeadline: result.returnDeadline ? new Date(result.returnDeadline) : null,
    rawParseJson: result,
  };
}

export function purchaseToMergeState(purchase: Purchase): PurchaseMergeState {
  return {
    retailer: purchase.retailer,
    itemName: purchase.itemName,
    orderNumber: purchase.orderNumber,
    orderDate: purchase.orderDate,
    price: purchase.price ? purchase.price.toNumber() : null,
    currency: purchase.currency,
    returnDeadline: purchase.returnDeadline,
    // Never actually written back out - mergePurchaseData always keeps
    // incoming's rawParseJson, never existing's. This placeholder only
    // needs to satisfy PurchaseMergeState's shape.
    rawParseJson: (purchase.rawParseJson as Prisma.InputJsonValue) ?? {},
  };
}

// One field-by-field policy, shared by the live sync path and the cleanup
// script so "what does merging two emails of the same order mean" is
// answered in exactly one place.
//
// - retailer/itemName/orderNumber: first-seen wins (orderNumber is the
//   merge key itself, so it's identical across the whole group anyway).
// - orderDate + returnDeadline travel together as a pair, taking whichever
//   parse's orderDate is earlier: a shipped/delivered email restates a
//   *later* date than the true order date, never earlier (also true of
//   Tier 2's own "use the email's Date: header as a fallback" behavior),
//   and returnDeadline was computed from that same parse's orderDate in
//   lib/parse.ts's finishHit - never independently recomputed here.
// - price/currency: fill-gap only. Never overwrite a known price with a
//   different one - a shipping/delivery email can carry partial or
//   garbled pricing.
// - rawParseJson: diagnostics only, never rendered (app/purchases-list.tsx)
//   - always keep the latest.
// - status is deliberately not part of this state at all: never touched
//   by any merge, same "re-sync never reverts RETURNED/KEEPING" rule as
//   the gmailMessageId path below.
export function mergePurchaseData(
  existing: PurchaseMergeState,
  incoming: PurchaseMergeState,
): PurchaseMergeState {
  const incomingIsEarlier = incoming.orderDate.getTime() < existing.orderDate.getTime();
  return {
    retailer: existing.retailer,
    itemName: existing.itemName,
    orderNumber: existing.orderNumber,
    orderDate: incomingIsEarlier ? incoming.orderDate : existing.orderDate,
    returnDeadline: incomingIsEarlier ? incoming.returnDeadline : existing.returnDeadline,
    price: existing.price ?? incoming.price,
    currency: existing.currency ?? incoming.currency,
    rawParseJson: incoming.rawParseJson,
  };
}

async function upsertByGmailMessageId(
  userId: string,
  gmailMessageId: string,
  result: PurchaseResult,
): Promise<boolean> {
  const state = toMergeState(result);
  // update never touches status - a re-sync matching an existing
  // gmailMessageId must not silently undo a user's RETURNED/KEEPING
  // choice. Only create sets it, to the schema default.
  await prisma.purchase.upsert({
    where: { userId_gmailMessageId: { userId, gmailMessageId } },
    update: state,
    create: { userId, gmailMessageId, ...state },
  });
  return true;
}

// orderNumber path: find-or-create-with-retry. Two chunk-mates in the
// same sync batch (app/api/sync/route.ts's CONCURRENCY=5 Promise.all) can
// both race past the findUnique below with no existing row for the same
// order; the DB's own @@unique([userId, orderNumber]) constraint lets
// exactly one create() win, and the loser is caught (P2002) and merged
// into the winner instead of failing the sync.
//
// Known, accepted tradeoff: a merged row's gmailMessageId column can only
// ever hold the one message ID that created it. Messages 2..N of a
// multi-message order are never recorded there, so the sync route's
// "already synced" skip filter (keyed on gmailMessageId) won't recognize
// them on a future re-sync - they get re-fetched/re-parsed (an extra
// Tier 2 call) every time, then harmlessly re-merged into the same row
// via this path. Bounded waste, not unbounded row growth or a correctness
// bug - not worth a join-table redesign for this fix.
async function upsertByOrderNumber(
  userId: string,
  gmailMessageId: string,
  orderNumber: string,
  result: PurchaseResult,
): Promise<boolean> {
  const incoming = toMergeState(result);

  const existing = await prisma.purchase.findUnique({
    where: { userId_orderNumber: { userId, orderNumber } },
  });
  if (existing) {
    await mergeInto(existing, incoming, gmailMessageId);
    return false; // merged into an existing purchase, not a new one
  }

  try {
    // orderNumber explicit last: incoming.orderNumber is result.orderNumber
    // verbatim (possibly untrimmed), but the unique-key lookups above and
    // below use the trimmed value - keep the stored value consistent with
    // what future lookups will search for.
    await prisma.purchase.create({
      data: { userId, gmailMessageId, ...incoming, orderNumber },
    });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.purchase.findUniqueOrThrow({
        where: { userId_orderNumber: { userId, orderNumber } },
      });
      await mergeInto(winner, incoming, gmailMessageId);
      return false;
    }
    throw err;
  }
}

async function mergeInto(
  existing: Purchase,
  incoming: PurchaseMergeState,
  gmailMessageId: string,
): Promise<void> {
  const merged = mergePurchaseData(purchaseToMergeState(existing), incoming);
  await prisma.purchase.update({ where: { id: existing.id }, data: merged });
  console.log("purchases: merged duplicate order", {
    purchaseId: existing.id,
    gmailMessageId,
  });
}

// Single entry point app/api/sync/route.ts calls per parsed message.
// orderNumber, when present (trimmed, non-empty), identifies the
// real-world order and takes precedence over gmailMessageId - see the
// dedup/merge comment block above. Returns whether this call resulted in
// a genuinely new Purchase row (false when merged into an existing one).
export async function upsertPurchaseFromParse(
  userId: string,
  gmailMessageId: string,
  result: PurchaseResult,
): Promise<boolean> {
  const orderNumber = result.orderNumber?.trim() || null;
  if (orderNumber) {
    return upsertByOrderNumber(userId, gmailMessageId, orderNumber, result);
  }
  return upsertByGmailMessageId(userId, gmailMessageId, result);
}

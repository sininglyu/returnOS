// One-off cleanup for the duplicate-purchase-rows bug: a single real order
// sends multiple Gmail messages (confirmation, shipped, delivered, ...),
// each with its own gmailMessageId, and gmailMessageId-only dedup let each
// one create a separate Purchase row for the same order. This collapses
// existing duplicate groups (Purchase rows sharing a non-null orderNumber
// for the same user) into one row each, using the exact same field-merge
// policy the live sync path now uses (lib/purchases.ts's
// mergePurchaseData) - so this script's plan and prisma/schema.prisma's
// new @@unique([userId, orderNumber]) constraint agree on what "the same
// order" means.
//
// Must be run (with --apply) BEFORE `npx prisma migrate dev` adds that
// constraint - existing duplicate data would violate it otherwise.
//
// Default is a dry run: reports what would happen, changes nothing.
// `--apply` performs the merge for real, per group, inside a transaction.
//
// Run via `npm run dedupe-purchases` (dry run) or
// `npm run dedupe-purchases -- --apply`.
//
// Reuses the app's own prisma singleton (lib/db.ts), same as
// prisma/seed.ts, rather than a bare `new PrismaClient()`.

// Plain `tsx` (unlike `npx prisma db seed`, which goes through
// prisma.config.ts) doesn't load .env.local on its own. `import`
// statements are hoisted ahead of this file's own top-level code no
// matter their textual order (confirmed - a plain `import { prisma } from
// "../lib/db"` above a `config(...)` call still ran lib/db.ts's eager
// `new PrismaPg({ connectionString: process.env.DATABASE_URL })` before
// DATABASE_URL was populated). Load dotenv first; everything that
// transitively touches lib/db.ts is imported dynamically inside main(),
// after config() has run, so it only evaluates then. (A top-level dynamic
// import would have the same effect, but esbuild's cjs output - what tsx
// produces for a file in a package.json without "type": "module" - doesn't
// support top-level await, hence deferring into main() instead.)
import { config } from "dotenv";
config({ path: ".env.local" });

import type { Purchase } from "@prisma/client";
import type { PurchaseMergeState } from "../lib/purchases";

const APPLY = process.argv.includes("--apply");

function formatPrice(state: PurchaseMergeState): string {
  if (state.price === null) return "null";
  return state.currency ? `${state.currency} ${state.price.toFixed(2)}` : String(state.price);
}

type DbModule = typeof import("../lib/db");
type PurchasesModule = typeof import("../lib/purchases");

async function findDuplicateGroups(prisma: DbModule["prisma"]): Promise<Purchase[][]> {
  // groupBy can report the (userId, orderNumber) pairs with count > 1, but
  // still needs a second query to fetch the actual rows - fetch everything
  // with a non-null orderNumber once and group in memory instead, cheap at
  // this table's size and avoids a second round trip per group.
  const candidates = await prisma.purchase.findMany({
    where: { orderNumber: { not: null } },
    orderBy: { createdAt: "asc" },
  });

  const byKey = new Map<string, Purchase[]>();
  for (const purchase of candidates) {
    const key = `${purchase.userId}:${purchase.orderNumber}`;
    const group = byKey.get(key);
    if (group) group.push(purchase);
    else byKey.set(key, [purchase]);
  }

  return [...byKey.values()].filter((group) => group.length > 1);
}

// Thrown when a group has two or more DIFFERENT non-RETURNABLE statuses
// (e.g. one row RETURNED, another KEEPING) - genuinely contradictory user
// actions recorded on what should be one purchase. Caught in main() to
// skip the group with a loud warning rather than guessing.
class ConflictingStatusError extends Error {
  constructor(public readonly group: Purchase[]) {
    super("conflicting statuses in duplicate group");
  }
}

// Picks which row survives. group is createdAt-asc (see findDuplicateGroups).
//
// mergePurchaseData never touches status at all - by construction here,
// status just comes along for free as whatever the chosen primary already
// has (Prisma's update() only writes fields present in `merged`, so
// primary.status in the DB is left exactly as-is).
//
// If the user already resolved one copy (RETURNED/KEEPING) while other
// duplicates are still RETURNABLE - confirmed to actually exist in this
// data (one order: KEEPING + RETURNABLE + RETURNABLE) - blindly keeping
// "earliest created" would silently delete the row carrying the user's
// real decision. So: any non-RETURNABLE row outranks every RETURNABLE
// row; among same-status rows, earliest createdAt wins. Two DIFFERENT
// non-RETURNABLE statuses in one group is a real conflict, not something
// to guess at - throws instead.
function pickPrimary(group: Purchase[]): Purchase {
  const resolved = group.filter((p) => p.status !== "RETURNABLE");
  if (resolved.length === 0) return group[0];

  const distinctStatuses = new Set(resolved.map((p) => p.status));
  if (distinctStatuses.size > 1) throw new ConflictingStatusError(group);

  return resolved[0]; // resolved subset preserves the group's createdAt-asc order
}

// Sequentially folds every other row into the chosen primary using
// mergePurchaseData, carrying the running merged state forward between
// folds (so a 3-4-way group merges correctly against the accumulated
// result, not just pairwise against the untouched primary row). Returns
// the primary row and the final merged field values - shared by both the
// report path and the --apply path so the dry run's printed plan is
// exactly what --apply executes.
function planMerge(
  group: Purchase[],
  mergePurchaseData: PurchasesModule["mergePurchaseData"],
  purchaseToMergeState: PurchasesModule["purchaseToMergeState"],
): { primary: Purchase; merged: PurchaseMergeState } {
  const primary = pickPrimary(group);
  let state = purchaseToMergeState(primary);
  for (const row of group) {
    if (row.id === primary.id) continue;
    state = mergePurchaseData(state, purchaseToMergeState(row));
  }
  return { primary, merged: state };
}

async function main() {
  const { prisma } = await import("../lib/db");
  const { mergePurchaseData, purchaseToMergeState } = await import("../lib/purchases");

  try {
    const groups = await findDuplicateGroups(prisma);

    if (groups.length === 0) {
      console.log("No duplicate orderNumber groups found. Nothing to do.");
      return;
    }

    let totalLoserRows = 0;
    let dollarDelta = 0;
    let remindersMigrated = 0;
    let conflicts = 0;

    for (const group of groups) {
      let primary: Purchase;
      let merged: PurchaseMergeState;
      try {
        ({ primary, merged } = planMerge(group, mergePurchaseData, purchaseToMergeState));
      } catch (err) {
        if (err instanceof ConflictingStatusError) {
          conflicts++;
          console.log(
            `\norderNumber ${group[0].orderNumber} (${group[0].retailer}) - SKIPPED, conflicting statuses:`,
          );
          for (const row of group) {
            console.log(`  id=${row.id} gmailMessageId=${row.gmailMessageId} status=${row.status}`);
          }
          console.log("  Resolve manually - not merged.");
          continue;
        }
        throw err;
      }
      const losers = group.filter((p) => p.id !== primary.id);
      totalLoserRows += losers.length;

      // Today's inflated "Refundable if you act" total (app/purchases-list.tsx)
      // sums every row's price, duplicates included. After merge, exactly one
      // price value survives per group (merged.price) - the delta is what the
      // rest of the group was contributing on top of that.
      const groupPriceSum = group.reduce((sum, p) => sum + (p.price ? p.price.toNumber() : 0), 0);
      dollarDelta += groupPriceSum - (merged.price ?? 0);

      console.log(`\norderNumber ${primary.orderNumber} (${primary.retailer}) - ${group.length} rows:`);
      for (const row of group) {
        const marker = row.id === primary.id ? "primary" : "loser ";
        console.log(
          `  [${marker}] id=${row.id} gmailMessageId=${row.gmailMessageId} ` +
            `createdAt=${row.createdAt.toISOString()} orderDate=${row.orderDate.toISOString().slice(0, 10)} ` +
            `price=${row.price ?? "null"} status=${row.status}`,
        );
      }
      console.log(
        `  -> merged: orderDate=${merged.orderDate.toISOString().slice(0, 10)} ` +
          `price=${formatPrice(merged)} returnDeadline=${
            merged.returnDeadline ? merged.returnDeadline.toISOString().slice(0, 10) : "null"
          }`,
      );

      if (!APPLY) continue;

      await prisma.$transaction(async (tx) => {
        for (const loser of losers) {
          const loserReminders = await tx.reminder.findMany({ where: { purchaseId: loser.id } });
          for (const reminder of loserReminders) {
            await tx.reminder.upsert({
              where: {
                purchaseId_daysBefore: { purchaseId: primary.id, daysBefore: reminder.daysBefore },
              },
              update: {},
              create: {
                purchaseId: primary.id,
                daysBefore: reminder.daysBefore,
                sentAt: reminder.sentAt,
              },
            });
            remindersMigrated++;
          }
        }

        await tx.purchase.deleteMany({ where: { id: { in: losers.map((p) => p.id) } } });
        await tx.purchase.update({ where: { id: primary.id }, data: merged });
      });
    }

    console.log(
      `\n${APPLY ? "Applied" : "Would apply"}: ${groups.length - conflicts} of ${groups.length} groups, ` +
        `${totalLoserRows} rows removed, ~$${dollarDelta.toFixed(2)} off the refundable total` +
        (conflicts > 0 ? `, ${conflicts} group(s) skipped (conflicting statuses)` : "") +
        (APPLY ? `, ${remindersMigrated} reminder(s) migrated.` : "."),
    );
    if (!APPLY) {
      console.log("Dry run only - re-run with --apply to perform this for real.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Seeds dev/demo data: the RetailerPolicy fallback table (V1 checklist item
// 8) plus one demo user with a spread of Purchase scenarios for building the
// purchases UI (item 5) against real rows before Gmail/Claude sync exist.
// Run via `npx prisma db seed` (configured in package.json).
//
// Reuses the app's own prisma singleton (lib/db.ts) rather than a bare
// `new PrismaClient()` — Prisma 7 requires the driver adapter to connect at
// all (see lib/db.ts), a plain client has none.

import { prisma } from "../lib/db";
import { addDaysUTC } from "../lib/dates";
import type { PurchaseStatus } from "@prisma/client";

// Approximate return windows for ~8 major retailers. These are reasonable
// dev-seed defaults, NOT verified against each retailer's current published
// policy — re-verify before relying on them for real deadline calculations
// (see lib/retailers.ts TODO).
const RETAILER_POLICIES: { retailer: string; returnWindowDays: number }[] = [
  { retailer: "Amazon", returnWindowDays: 30 },
  { retailer: "Target", returnWindowDays: 90 },
  { retailer: "Walmart", returnWindowDays: 90 },
  { retailer: "Best Buy", returnWindowDays: 15 },
  { retailer: "Costco", returnWindowDays: 90 },
  { retailer: "Nike", returnWindowDays: 30 },
  { retailer: "Zara", returnWindowDays: 30 },
  { retailer: "Nordstrom", returnWindowDays: 90 },
];

// example.com is IANA-reserved for documentation/testing — guaranteed not
// to be a real person's address. Never seed a real user's email here.
const DEMO_USER_EMAIL = "demo@example.com";

const now = new Date();

interface SeedPurchase {
  gmailMessageId: string;
  retailer: string;
  itemName: string;
  orderDate: Date;
  price: string; // Prisma Decimal accepts a numeric string
  currency: string;
  orderNumber: string;
  returnDeadline: Date | null;
  status: PurchaseStatus;
}

const SEED_PURCHASES: SeedPurchase[] = [
  {
    // Deadline in 2 days.
    gmailMessageId: "seed-amazon-2d",
    retailer: "Amazon",
    itemName: "Wireless Noise-Cancelling Headphones",
    orderDate: addDaysUTC(now, -28),
    price: "179.99",
    currency: "USD",
    orderNumber: "AMZ-SEED-0001",
    returnDeadline: addDaysUTC(now, 2),
    status: "RETURNABLE",
  },
  {
    // Deadline in 7 days.
    gmailMessageId: "seed-nike-7d",
    retailer: "Nike",
    itemName: "Air Zoom Pegasus Running Shoes",
    orderDate: addDaysUTC(now, -23),
    price: "129.0",
    currency: "USD",
    orderNumber: "NIKE-SEED-0002",
    returnDeadline: addDaysUTC(now, 7),
    status: "RETURNABLE",
  },
  {
    // Deadline in 15 days.
    gmailMessageId: "seed-walmart-15d",
    retailer: "Walmart",
    itemName: "12-Piece Non-Stick Cookware Set",
    orderDate: addDaysUTC(now, -75),
    price: "89.5",
    currency: "USD",
    orderNumber: "WM-SEED-0003",
    returnDeadline: addDaysUTC(now, 15),
    status: "RETURNABLE",
  },
  {
    // Deadline already passed, never returned.
    gmailMessageId: "seed-bestbuy-expired",
    retailer: "Best Buy",
    itemName: "USB-C Fast Charger (65W)",
    orderDate: addDaysUTC(now, -40),
    price: "34.99",
    currency: "USD",
    orderNumber: "BBY-SEED-0004",
    returnDeadline: addDaysUTC(now, -25),
    status: "EXPIRED",
  },
  {
    // User decided to keep it.
    gmailMessageId: "seed-target-keeping",
    retailer: "Target",
    itemName: "Standing Desk Converter",
    orderDate: addDaysUTC(now, -50),
    price: "159.0",
    currency: "USD",
    orderNumber: "TGT-SEED-0005",
    returnDeadline: addDaysUTC(now, -5),
    status: "KEEPING",
  },
  {
    // Already returned.
    gmailMessageId: "seed-costco-returned",
    retailer: "Costco",
    itemName: "Stainless Steel Vacuum Insulated Bottle (2-Pack)",
    orderDate: addDaysUTC(now, -60),
    price: "24.99",
    currency: "USD",
    orderNumber: "COST-SEED-0006",
    returnDeadline: addDaysUTC(now, -20),
    status: "RETURNED",
  },
  {
    // Retailer not in the policy table -> deadline unknown.
    gmailMessageId: "seed-unknown-retailer",
    retailer: "Riverside Local Boutique",
    itemName: "Hand-Knit Wool Scarf",
    orderDate: addDaysUTC(now, -3),
    price: "42.0",
    currency: "USD",
    orderNumber: "RLB-SEED-0007",
    returnDeadline: null,
    status: "RETURNABLE",
  },
];

async function main() {
  for (const policy of RETAILER_POLICIES) {
    await prisma.retailerPolicy.upsert({
      where: { retailer: policy.retailer },
      update: policy,
      create: policy,
    });
  }

  const user = await prisma.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    update: {},
    create: {
      email: DEMO_USER_EMAIL,
      name: "Demo User",
    },
  });

  for (const purchase of SEED_PURCHASES) {
    await prisma.purchase.upsert({
      where: {
        userId_gmailMessageId: {
          userId: user.id,
          gmailMessageId: purchase.gmailMessageId,
        },
      },
      update: purchase,
      create: { ...purchase, userId: user.id },
    });
  }

  console.log(
    `Seeded ${RETAILER_POLICIES.length} retailer policies, 1 demo user, ${SEED_PURCHASES.length} purchases.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

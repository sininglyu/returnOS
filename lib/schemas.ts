// Zod schema for parse output (Tier 1: lib/structuredData.ts; Tier 2, when
// it exists: an LLM). A response that fails validation is logged and
// skipped, never inserted (CLAUDE.md "Parsing rules"). Non-purchase
// emails return { isPurchase: false } and the caller skips the row.

import { z } from "zod";

// orderDate feeds addDaysUTC (lib/dates.ts) for the retailer-policy
// fallback deadline - an unparseable value should fail validation here
// (-> logged + skipped) rather than silently producing an Invalid Date
// Purchase row downstream.
const isParseableDate = (value: string) => !Number.isNaN(Date.parse(value));

export const parseResultSchema = z.discriminatedUnion("isPurchase", [
  z.object({
    isPurchase: z.literal(false),
  }),
  z.object({
    isPurchase: z.literal(true),
    retailer: z.string().min(1),
    itemName: z.string().min(1),
    orderDate: z.string().refine(isParseableDate, {
      message: "orderDate must be a parseable date string",
    }), // ISO date string; converted to UTC in lib/dates.ts
    price: z.number().nonnegative().nullable(),
    currency: z.string().nullable(),
    orderNumber: z.string().nullable(),
    returnDeadline: z.string().nullable(), // stated in email, if present
  }),
]);

export type ParseResult = z.infer<typeof parseResultSchema>;

// The "hit" branch of ParseResult, shared by lib/parse.ts (both tiers) and
// lib/purchases.ts (the upsert/merge layer) - single source of truth so
// neither redeclares it.
export type PurchaseResult = Extract<ParseResult, { isPurchase: true }>;

// Zod schema for Claude's parse output. A response that fails validation is
// logged and skipped, never inserted (CLAUDE.md "Parsing rules").

import { z } from "zod";

// TODO(item 4): finalize fields against real Claude output. Non-purchase
// emails return { isPurchase: false } and the caller skips the row.

export const parseResultSchema = z.discriminatedUnion("isPurchase", [
  z.object({
    isPurchase: z.literal(false),
  }),
  z.object({
    isPurchase: z.literal(true),
    retailer: z.string(),
    itemName: z.string(),
    orderDate: z.string(), // ISO date string; converted to UTC in lib/dates.ts
    price: z.number().nullable(),
    currency: z.string().nullable(),
    orderNumber: z.string().nullable(),
    returnDeadline: z.string().nullable(), // stated in email, if present
  }),
]);

export type ParseResult = z.infer<typeof parseResultSchema>;

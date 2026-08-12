// Retailer return-policy fallback table. Used by lib/parse.ts only when the
// email itself doesn't state a return deadline (CLAUDE.md "Parsing rules").
// Backed by the RetailerPolicy model (prisma/schema.prisma), seeded with
// ~8 major retailers via prisma/seed.ts (V1 checklist item 8).

import type { RetailerPolicy } from "@prisma/client";
import { prisma } from "./db";

// Case-insensitive exact match against the seeded table. lib/parse.ts
// trims the retailer string before calling this. Fuzzy matching (e.g. a
// parsed "Amazon.com" not matching the seeded "Amazon") is a known V1
// limitation, not solved here - consistent with "do not build past this
// line."
export async function getRetailerPolicy(
  retailer: string,
): Promise<RetailerPolicy | null> {
  return prisma.retailerPolicy.findFirst({
    where: { retailer: { equals: retailer, mode: "insensitive" } },
  });
}

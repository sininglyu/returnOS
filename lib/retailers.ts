// Retailer return-policy fallback table. Used by lib/parse.ts only when the
// email itself doesn't state a return deadline (CLAUDE.md "Parsing rules").
// Backed by the RetailerPolicy model (prisma/schema.prisma), seeded with
// ~8 major retailers via prisma/seed.ts (V1 checklist item 8).

import type { RetailerPolicy } from "@prisma/client";
import { prisma } from "./db";

// Lowercase, trim, strip a trailing TLD-ish suffix (".com", ".co.uk", ...),
// collapse whitespace. So a Tier 2-extracted "Amazon.com" and the seeded
// "Amazon" both normalize to "amazon" and match. Deliberately narrow -
// only what's needed to close the gap actually seen on real inbox data;
// not a general retailer-name fuzzy-matcher.
function normalizeRetailer(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/(\.[a-z]{2,3})+$/, "")
    .replace(/\s+/g, " ");
}

// Matches against the seeded table (~8 rows) by normalized name rather
// than exact string, so "Amazon.com" (what Tier 2 actually extracts)
// resolves against the seeded "Amazon". Table is small enough that
// findMany + in-memory compare is simpler than a DB-side normalized
// column/index - see CLAUDE.md for the scale-up path if that changes.
export async function getRetailerPolicy(
  retailer: string,
): Promise<RetailerPolicy | null> {
  const target = normalizeRetailer(retailer);
  const policies = await prisma.retailerPolicy.findMany();
  return (
    policies.find((policy) => normalizeRetailer(policy.retailer) === target) ??
    null
  );
}

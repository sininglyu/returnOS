// Retailer return-policy fallback table. Used by lib/parse.ts only when the
// email itself doesn't state a return deadline (CLAUDE.md "Parsing rules").
// Backed by the RetailerPolicy model (prisma/schema.prisma), seeded with
// ~8 major retailers via prisma/seed.ts (V1 checklist item 8).

import type { RetailerPolicy } from "@prisma/client";

// TODO(item 8): implement via prisma (lib/db.ts) — look up by retailer name
// (case-insensitive match against however lib/parse.ts normalizes Claude's
// `retailer` field).

export async function getRetailerPolicy(
  _retailer: string,
): Promise<RetailerPolicy | null> {
  throw new Error("not implemented");
}

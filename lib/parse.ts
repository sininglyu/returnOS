// Orchestrates the parsing pipeline. Phase 1 (current): Tier 1 only -
// lib/structuredData.ts's schema.org extraction, Zod-validated, with the
// retailer-policy fallback for returnDeadline. Tier 2 (an LLM, not yet
// built - see plan) will slot in as an additional fallback when Tier 1
// misses; parseCandidateEmail's signature and "log + skip on nothing
// found" contract are already shaped for that so it's additive later, not
// a rework.
//
// IMPORTANT: never log the raw or stripped email body, or bodyHtml —
// message IDs, retailer names, and parse outcomes only.

import type { GmailMessage } from "./gmail";
import { parseResultSchema, type ParseResult } from "./schemas";
import { extractStructuredPurchase } from "./structuredData";
import { getRetailerPolicy } from "./retailers";
import { addDaysUTC } from "./dates";

export async function parseCandidateEmail(
  message: GmailMessage,
): Promise<ParseResult | null> {
  const structured = extractStructuredPurchase(message.bodyHtml);

  if (!structured) {
    console.log("parse: no usable structured data", {
      messageId: message.id,
      outcome: "tier1-miss",
    });
    return null;
  }

  const validated = parseResultSchema.safeParse(structured);
  if (!validated.success) {
    console.log("parse: structured data failed validation", {
      messageId: message.id,
      outcome: "tier1-invalid",
    });
    return null;
  }

  if (!validated.data.isPurchase) {
    // extractStructuredPurchase never actually produces this branch, but
    // ParseResult is a union — narrow it properly rather than assert.
    return null;
  }

  const result = validated.data;
  let returnDeadline = result.returnDeadline;

  if (!returnDeadline) {
    const policy = await getRetailerPolicy(result.retailer.trim());
    if (policy) {
      const orderDate = new Date(result.orderDate);
      if (!Number.isNaN(orderDate.getTime())) {
        returnDeadline = addDaysUTC(
          orderDate,
          policy.returnWindowDays,
        ).toISOString();
      }
    }
    // No policy found -> returnDeadline stays null ("policy unknown").
  }

  console.log("parse: tier1 hit", {
    messageId: message.id,
    retailer: result.retailer,
  });

  return { ...result, returnDeadline };
}

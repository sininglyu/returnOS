// Orchestrates the parsing pipeline (see CLAUDE.md "Parsing rules"):
// Tier 1 - lib/structuredData.ts's schema.org extraction, local and free.
// On a miss, Tier 2 - lib/openai.ts's LLM fallback, only when
// OPENAI_API_KEY is configured. Both tiers produce the same ParseResult
// shape, are Zod-validated, and share one retailer-policy fallback path.
//
// IMPORTANT: never log the raw or stripped email body, or bodyHtml —
// message IDs, retailer names, and parse outcomes only.

import type { GmailMessage } from "./gmail";
import { parseResultSchema, type ParseResult } from "./schemas";
import { extractStructuredPurchase } from "./structuredData";
import { parseEmailWithOpenAI } from "./openai";
import { getRetailerPolicy } from "./retailers";
import { addDaysUTC } from "./dates";

type PurchaseResult = Extract<ParseResult, { isPurchase: true }>;

// Shared tail for both tiers: apply the retailer-policy fallback when the
// email itself didn't state a return deadline, then log the hit. Kept as
// one function so Tier 1 and Tier 2 can't drift on this behavior.
async function finishHit(
  messageId: string,
  tier: "tier1" | "tier2",
  result: PurchaseResult,
): Promise<ParseResult> {
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

  console.log(`parse: ${tier} hit`, { messageId, retailer: result.retailer });

  return { ...result, returnDeadline };
}

async function tryTier2(message: GmailMessage): Promise<ParseResult | null> {
  if (!process.env.OPENAI_API_KEY) {
    console.log("parse: tier2 skipped", {
      messageId: message.id,
      outcome: "skipped-no-llm-configured",
    });
    return null;
  }

  let raw: ParseResult;
  try {
    raw = await parseEmailWithOpenAI({
      subject: message.subject,
      from: message.from,
      date: message.date,
      bodyText: message.bodyText,
    });
  } catch (err) {
    console.log("parse: tier2 call failed", {
      messageId: message.id,
      outcome: "tier2-error",
      errorType: err instanceof Error ? err.name : typeof err,
    });
    return null;
  }

  const validated = parseResultSchema.safeParse(raw);
  if (!validated.success) {
    console.log("parse: tier2 output failed validation", {
      messageId: message.id,
      outcome: "tier2-invalid",
    });
    return null;
  }

  if (!validated.data.isPurchase) {
    console.log("parse: tier2 not a purchase", {
      messageId: message.id,
      outcome: "tier2-not-purchase",
    });
    return null;
  }

  return finishHit(message.id, "tier2", validated.data);
}

export async function parseCandidateEmail(
  message: GmailMessage,
): Promise<ParseResult | null> {
  const structured = extractStructuredPurchase(message.bodyHtml);

  if (!structured) {
    console.log("parse: no usable structured data", {
      messageId: message.id,
      outcome: "tier1-miss",
    });
    return tryTier2(message);
  }

  const validated = parseResultSchema.safeParse(structured);
  if (!validated.success) {
    console.log("parse: structured data failed validation", {
      messageId: message.id,
      outcome: "tier1-invalid",
    });
    return tryTier2(message);
  }

  if (!validated.data.isPurchase) {
    // extractStructuredPurchase never actually produces this branch, but
    // ParseResult is a union — narrow it properly rather than assert.
    return null;
  }

  return finishHit(message.id, "tier1", validated.data);
}

// Tier 2 of the parsing pipeline (see CLAUDE.md "Parsing rules"): an LLM
// fallback, only reached when Tier 1 (lib/structuredData.ts) misses. All
// calls to the model go through this file so they can be mocked in tests —
// nothing outside lib/ should import "ai" or "@ai-sdk/openai" directly.
//
// Model: gpt-5-nano (see CLAUDE.md stack table).
//
// IMPORTANT: never log the prompt or the raw model response — both contain
// email content. This module doesn't log at all, same as
// lib/structuredData.ts — the caller (lib/parse.ts) logs message IDs and
// outcomes only, so it can attach the real message ID to a failure.
// Errors from the model call propagate; the caller catches, classifies,
// and treats any failure as a Tier 2 miss.

import { z } from "zod";
import { generateText, Output } from "ai";
import { openai } from "@ai-sdk/openai";
import type { ParseResult } from "./schemas";

// Order-confirmation emails carry the fields we need near the top (item,
// price, order number); the rest is usually boilerplate (shipping policy,
// footer links, unsubscribe text). Capping keeps token spend bounded even
// though lib/gmail.ts has seen bodyText run 39-132KB on real messages.
const MAX_BODY_TEXT_CHARS = 12_000;

// What we ask the model for is intentionally NOT parseResultSchema
// directly: that's a Zod discriminatedUnion, which compiles to a JSON
// Schema "oneOf" at the root - and OpenAI's structured-output mode
// rejects a root-level oneOf ("'oneOf' is not permitted"), confirmed
// against a real 400 from the API, not assumed. This flat, all-nullable
// shape is what the model actually fills in; mapToParseResult below
// reshapes it into parseResultSchema's union so lib/parse.ts's existing
// validation (shared with Tier 1) still gates what reaches the database.
const tier2OutputSchema = z.object({
  isPurchase: z.boolean(),
  retailer: z.string().nullable(),
  itemName: z.string().nullable(),
  orderDate: z.string().nullable(),
  price: z.number().nullable(),
  currency: z.string().nullable(),
  orderNumber: z.string().nullable(),
  returnDeadline: z.string().nullable(),
});
type Tier2Output = z.infer<typeof tier2OutputSchema>;

function mapToParseResult(raw: Tier2Output): ParseResult {
  if (!raw.isPurchase) return { isPurchase: false };
  return {
    isPurchase: true,
    // Empty string on a missing required field is intentional, not a
    // guess at real data - it fails parseResultSchema's .min(1) check in
    // lib/parse.ts, which is what turns this into a skip rather than a
    // partial Purchase row.
    retailer: raw.retailer ?? "",
    itemName: raw.itemName ?? "",
    orderDate: raw.orderDate ?? "",
    price: raw.price,
    currency: raw.currency,
    orderNumber: raw.orderNumber,
    returnDeadline: raw.returnDeadline,
  };
}

const SYSTEM_PROMPT = `You classify and extract data from e-commerce emails.

Determine whether this email is a purchase/order confirmation (not a
shipping-only update, a marketing email, a review request, or anything
else). If it is not a purchase confirmation, or you cannot find both a
retailer name and an item name, respond with isPurchase: false.

If it is a purchase confirmation, extract:
- retailer: the store/brand name
- itemName: the purchased item (first/primary item if there are several)
- orderDate: the date the order was placed, as an ISO date string (e.g.
  "2026-08-01"). If the body doesn't explicitly restate the order date,
  use the email's own "Date:" field above as your best estimate — for an
  order-confirmation email, the send date is a reasonable proxy for the
  order date. Only return null here if you can't find a date anywhere,
  including that Date field.
- price: the item or order total, as a number, or null if not stated
- currency: the ISO currency code (e.g. "USD"), or null if not stated
- orderNumber: the order/confirmation number, or null if not stated
- returnDeadline: the return-by date, as an ISO date string, ONLY if the
  email explicitly states one — otherwise null. Do not calculate or guess.`;

export interface ParseEmailInput {
  subject: string;
  from: string;
  date: string;
  bodyText: string;
}

export async function parseEmailWithOpenAI(
  input: ParseEmailInput,
): Promise<ParseResult> {
  const bodyText =
    input.bodyText.length > MAX_BODY_TEXT_CHARS
      ? input.bodyText.slice(0, MAX_BODY_TEXT_CHARS)
      : input.bodyText;

  const { output } = await generateText({
    model: openai("gpt-5-nano"),
    output: Output.object({ schema: tier2OutputSchema }),
    system: SYSTEM_PROMPT,
    prompt: `Subject: ${input.subject}\nFrom: ${input.from}\nDate: ${input.date}\n\n${bodyText}`,
    providerOptions: {
      // Cheap classification/extraction task, not multi-step reasoning -
      // keep latency and cost down rather than defaulting to a higher
      // effort tier.
      openai: { reasoningEffort: "low" },
    },
  });

  return mapToParseResult(output);
}

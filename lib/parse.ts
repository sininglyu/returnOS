// Orchestrates: raw Gmail message -> HTML stripped -> Claude -> Zod validate
// -> either a validated ParseResult or a skip. This is the one place that
// calls both lib/claude.ts and lib/schemas.ts together.
//
// IMPORTANT: never log the raw or stripped email body — message IDs and
// parse outcomes (isPurchase, validation pass/fail) only.

import type { GmailMessage } from "./gmail";
import type { ParseResult } from "./schemas";

// TODO(item 4): strip HTML to plain text before calling Claude (never send
// raw HTML — wastes tokens per CLAUDE.md). Fall back to lib/retailers.ts for
// returnDeadline when the email doesn't state one; if the retailer is
// unknown, leave returnDeadline null ("policy unknown" in the UI).

export async function parseCandidateEmail(
  _message: GmailMessage,
): Promise<ParseResult | null> {
  throw new Error("not implemented");
}

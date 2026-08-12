// Anthropic client wrapper. All Claude calls go through this file so they
// can be mocked in tests — nothing outside lib/ should import
// @anthropic-ai/sdk directly.
//
// Model: claude-sonnet-4-6 (see CLAUDE.md stack table).
// IMPORTANT: never log the raw email body passed in the prompt.

// TODO(item 4): send subject/sender/date/plain-text body, demand JSON-only
// output (no prose, no markdown fences), return the raw text for
// lib/parse.ts to validate with the Zod schema in lib/schemas.ts.

export async function parseEmailWithClaude(_input: {
  subject: string;
  from: string;
  date: string;
  bodyText: string;
}): Promise<string> {
  throw new Error("not implemented");
}

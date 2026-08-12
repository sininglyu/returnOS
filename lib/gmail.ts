// Gmail API wrapper. All calls to Gmail go through this file so they can be
// mocked in tests — nothing outside lib/ should import googleapis directly.
//
// IMPORTANT: never log email bodies here. Log message IDs and counts only.

// TODO(item 3): search for order-confirmation candidates using the user's
// stored refresh token (from the Account row), returning message IDs +
// a pageToken for chunked sync. See plan §6 — /api/sync processes one page
// (~15-20 messages) per invocation, not the whole mailbox at once.

export interface GmailSearchResult {
  messageIds: string[];
  nextPageToken: string | null;
}

export async function searchCandidateEmails(
  _userId: string,
  _pageToken: string | null,
): Promise<GmailSearchResult> {
  throw new Error("not implemented");
}

// TODO(item 3): fetch a single message and return subject, sender, date, and
// plain-text body with HTML stripped (see lib/parse.ts — Claude never sees
// raw HTML).

export interface GmailMessage {
  id: string;
  subject: string;
  from: string;
  date: string;
  bodyText: string;
}

export async function fetchMessage(
  _userId: string,
  _messageId: string,
): Promise<GmailMessage> {
  throw new Error("not implemented");
}

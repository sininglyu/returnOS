// Manual "Sync now" (item 2). Chunked: processes one Gmail page (~15-20
// messages) per call and returns a cursor, rather than the whole mailbox in
// one request — see plan §6 on Vercel's maxDuration and why a single
// synchronous request can't do a full mailbox sync. The client drives a
// loop of these calls behind a progress bar.
//
// Route handler stays thin (CLAUDE.md convention): parse input, call
// lib/ functions, format the response. No Gmail/Claude/Prisma calls here
// directly.

import { NextRequest, NextResponse } from "next/server";

// TODO(item 2): auth() for the session -> lib/gmail.searchCandidateEmails
// (one page) -> lib/gmail.fetchMessage + lib/parse.parseCandidateEmail per
// message -> upsert each Purchase in its own transaction, keyed on
// [userId, gmailMessageId] -> increment SyncRun counters -> return
// { nextPageToken, done, messagesScanned, purchasesFound }.

export async function POST(_request: NextRequest) {
  return NextResponse.json(
    { error: "not implemented" },
    { status: 501 },
  );
}

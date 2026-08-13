// Manual "Sync now" (item 2). Chunked: processes one Gmail page (~15-20
// messages) per call and returns a cursor, rather than the whole mailbox in
// one request — see plan §6 on Vercel's maxDuration and why a single
// synchronous request can't do a full mailbox sync. The client
// (app/sync-button.tsx) drives a loop of these calls.
//
// Route handler stays thin (CLAUDE.md convention): parse input, call lib/
// functions, format the response. The one Prisma touchpoint beyond that is
// the upsert itself - orchestration, not business logic.
//
// IMPORTANT: never log email content - message IDs, retailer names, and
// counts only, same discipline as lib/gmail.ts and lib/parse.ts.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import {
  searchCandidateEmails,
  fetchMessage,
  GmailNotConnectedError,
} from "@/lib/gmail";
import { parseCandidateEmail } from "@/lib/parse";

// One page is SYNC_PAGE_SIZE (20) messages; worst case all 20 miss Tier 1
// and hit Tier 2 (one OpenAI call each) - comfortably inside 300s today.
// Redundant against the current Vercel default (see Vercel platform notes),
// but stated explicitly so it's revisited if SYNC_PAGE_SIZE or Tier 2
// latency ever changes materially.
export const maxDuration = 300;

const requestSchema = z.object({
  pageToken: z.string().nullish(),
  syncRunId: z.string().nullish(),
});

// Chunk size for the per-message loop below, not a Gmail/OpenAI rate-limit
// number - Gmail's per-user quota (250 units/sec, 5 units per messages.get)
// isn't close to being the constraint at this scale. 5 is just "don't fully
// serialize" without fanning out unboundedly for no measured benefit; a
// fifth of one SYNC_PAGE_SIZE page.
const CONCURRENCY = 5;

// Fetch -> parse -> upsert for one message. Returns whether a purchase was
// found, so the caller can sum results across a Promise.all'd chunk. The
// try/catch lives here, not around the Promise.all in POST - a chunk-mate's
// transient failure must not sink the other messages in the same chunk.
// GmailNotConnectedError is the one exception re-thrown rather than
// swallowed: it means the whole run is broken (token revoked/expired), not
// just this message, and needs to reach POST's outer catch to mark the
// SyncRun errored and return 409.
async function processMessage(
  userId: string,
  messageId: string,
): Promise<boolean> {
  try {
    const message = await fetchMessage(userId, messageId);
    const result = await parseCandidateEmail(message);
    if (!result || !result.isPurchase) return false;

    // update never touches status - a re-sync matching an existing
    // gmailMessageId must not silently undo a user's RETURNED/KEEPING
    // choice (item 6, not built yet). Only create sets it, to the schema
    // default.
    await prisma.purchase.upsert({
      where: {
        userId_gmailMessageId: { userId, gmailMessageId: messageId },
      },
      update: {
        retailer: result.retailer,
        itemName: result.itemName,
        orderDate: new Date(result.orderDate),
        price: result.price,
        currency: result.currency,
        orderNumber: result.orderNumber,
        returnDeadline: result.returnDeadline
          ? new Date(result.returnDeadline)
          : null,
        rawParseJson: result,
      },
      create: {
        userId,
        gmailMessageId: messageId,
        retailer: result.retailer,
        itemName: result.itemName,
        orderDate: new Date(result.orderDate),
        price: result.price,
        currency: result.currency,
        orderNumber: result.orderNumber,
        returnDeadline: result.returnDeadline
          ? new Date(result.returnDeadline)
          : null,
        rawParseJson: result,
      },
    });
    return true;
  } catch (err) {
    if (err instanceof GmailNotConnectedError) throw err;
    console.log("sync: per-message step failed", {
      messageId,
      errorType: err instanceof Error ? err.name : typeof err,
    });
    return false;
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsedBody = requestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsedBody.success) {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  const { pageToken, syncRunId } = parsedBody.data;

  let syncRun;
  if (syncRunId) {
    syncRun = await prisma.syncRun.findUnique({
      where: { id: syncRunId, userId },
    });
    if (!syncRun) {
      return NextResponse.json({ error: "sync run not found" }, { status: 404 });
    }
  } else {
    syncRun = await prisma.syncRun.create({
      data: { userId, startedAt: new Date() },
    });
  }

  try {
    const { messageIds, nextPageToken } = await searchCandidateEmails(
      userId,
      pageToken ?? null,
    );

    // Skip messages already synced - no fetch, no parse, no Tier 2 call.
    // Makes a re-sync near-free for unchanged mail instead of re-paying
    // OpenAI on every click.
    const alreadySynced = await prisma.purchase.findMany({
      where: { userId, gmailMessageId: { in: messageIds } },
      select: { gmailMessageId: true },
    });
    const alreadySyncedIds = new Set(alreadySynced.map((p) => p.gmailMessageId));
    const toProcess = messageIds.filter((id) => !alreadySyncedIds.has(id));

    // Bounded concurrency, not fully sequential - a real run measured 2.8min
    // for 20 messages one-at-a-time (Gmail fetch + Tier 2 OpenAI call each,
    // ~8s/message). Chunks of CONCURRENCY via Promise.all instead.
    let purchasesFound = 0;
    for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
      const chunk = toProcess.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map((messageId) => processMessage(userId, messageId)),
      );
      purchasesFound += results.filter(Boolean).length;
    }

    const done = nextPageToken === null;
    const updatedRun = await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        messagesScanned: { increment: messageIds.length },
        purchasesFound: { increment: purchasesFound },
        ...(done ? { finishedAt: new Date() } : {}),
      },
    });

    return NextResponse.json({
      syncRunId: syncRun.id,
      nextPageToken,
      done,
      messagesScanned: updatedRun.messagesScanned,
      purchasesFound: updatedRun.purchasesFound,
    });
  } catch (err) {
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        finishedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
      },
    });

    if (err instanceof GmailNotConnectedError) {
      return NextResponse.json({ error: "not-connected" }, { status: 409 });
    }

    console.log("sync: run failed", {
      syncRunId: syncRun.id,
      errorType: err instanceof Error ? err.name : typeof err,
    });
    return NextResponse.json({ error: "sync-failed" }, { status: 500 });
  }
}

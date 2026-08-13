// Gmail API wrapper. All calls to Gmail go through this file so they can be
// mocked in tests — nothing outside lib/ should import googleapis directly.
//
// IMPORTANT: never log email bodies here. Log message IDs and counts only.

import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { prisma } from "./db";

// Thrown whenever the caller has no usable Google connection - either no
// Account row was ever linked, or the stored refresh_token has been revoked
// or expired (Google returns invalid_grant on refresh). This app is still
// on Google's "Testing" publishing status (see item 1's plan notes), where
// refresh tokens hard-expire after 7 days, so the latter case is an
// expected weekly occurrence, not a rare fault. /api/sync (item 2) can
// catch this one error type and tell the user to reconnect, regardless of
// which of the two caused it.
export class GmailNotConnectedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GmailNotConnectedError";
  }
}

// Matches /api/sync's stub comment: ~15-20 messages per page per sync
// invocation, chunked to fit inside a single request's time budget rather
// than scanning the whole mailbox synchronously.
export const SYNC_PAGE_SIZE = 20;

// Broad recall net, not a precise filter - Claude (item 4) is the real
// classifier. This just keeps the candidate pool (and Claude token spend)
// away from the whole mailbox. 180 days covers every seeded RetailerPolicy
// window (max 90 days) with headroom to still surface recently-expired
// purchases in the UI.
const SEARCH_QUERY =
  '(subject:(order OR receipt OR shipped OR delivered OR confirmation) OR "order number") newer_than:180d -category:promotions -category:social -category:forums';

function isInvalidGrantError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const response = (err as { response?: { data?: { error?: string } } })
    .response;
  return response?.data?.error === "invalid_grant";
}

// Builds an authorized Gmail client from the user's stored refresh token,
// refreshing (and persisting) the access token first if it's expired.
async function getGmailClient(userId: string): Promise<gmail_v1.Gmail> {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "google" },
  });

  if (!account?.refresh_token) {
    throw new GmailNotConnectedError(
      `No Google account linked for user ${userId}`,
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.AUTH_GOOGLE_ID,
    process.env.AUTH_GOOGLE_SECRET,
  );

  oauth2Client.setCredentials({
    refresh_token: account.refresh_token,
    access_token: account.access_token ?? undefined,
    // expires_at is a nullable Int - `null * 1000` would silently become 0,
    // and a falsy expiry_date reads as "not expiring" to the client library.
    expiry_date: account.expires_at ? account.expires_at * 1000 : undefined,
  });

  // Captures the persistence write triggered by a token refresh below, so
  // it can be awaited before this function returns instead of left
  // fire-and-forget: emit("tokens", ...) invokes this listener
  // synchronously but does not await its inner promise, and a dangling
  // write can lose the race against the serverless function freezing right
  // after the response is sent.
  let persistPromise: Promise<unknown> | null = null;
  oauth2Client.on("tokens", (tokens) => {
    persistPromise = prisma.account
      .update({
        where: { id: account.id },
        data: {
          access_token: tokens.access_token ?? undefined,
          expires_at: tokens.expiry_date
            ? Math.floor(tokens.expiry_date / 1000)
            : undefined,
        },
      })
      .catch((err) => {
        // Worst case of a failed write: one wasted refresh call next time,
        // not a broken sync run - log and let the caller continue.
        console.error("gmail: failed to persist refreshed access token", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  });

  try {
    // Forces the proactive expiry check now (rather than lazily on the
    // first API call below) so any refresh - and the listener above - runs
    // and is awaited before we return, not mid-request.
    await oauth2Client.getAccessToken();
  } catch (err) {
    if (isInvalidGrantError(err)) {
      throw new GmailNotConnectedError(
        `Google refresh token for user ${userId} is invalid or revoked`,
        { cause: err },
      );
    }
    throw err;
  }

  if (persistPromise) {
    await persistPromise;
  }

  return google.gmail({ version: "v1", auth: oauth2Client });
}

export interface GmailSearchResult {
  messageIds: string[];
  nextPageToken: string | null;
  // Gmail's own doc calls this "Estimated total number of results" - not
  // exact, and can shift between pages of the same search. Surfaced so the
  // client can show an approximate "X of ~Y" instead of an unbounded count
  // with no sense of when a sync will finish.
  resultSizeEstimate: number | null;
}

export async function searchCandidateEmails(
  userId: string,
  pageToken: string | null,
): Promise<GmailSearchResult> {
  const gmail = await getGmailClient(userId);

  const { data } = await gmail.users.messages.list({
    userId: "me",
    q: SEARCH_QUERY,
    maxResults: SYNC_PAGE_SIZE,
    pageToken: pageToken ?? undefined,
  });

  const messageIds = (data.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id));

  console.log("gmail: search returned candidates", {
    userId,
    count: messageIds.length,
  });

  return {
    messageIds,
    nextPageToken: data.nextPageToken ?? null,
    resultSizeEstimate: data.resultSizeEstimate ?? null,
  };
}

export interface GmailMessage {
  id: string;
  subject: string;
  from: string;
  date: string;
  bodyText: string;
  // Raw HTML body, when present. Only lib/structuredData.ts (Tier 1 -
  // schema.org extraction) reads this; it inspects markup that gets
  // stripped out of bodyText. Never send this to an external model -
  // bodyText (already stripped) is what leaves this process.
  bodyHtml: string;
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return (
    headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

interface ExtractedBody {
  bodyText: string;
  bodyHtml: string;
}

// Walks a message payload's MIME tree looking for a text/plain part
// (-> bodyText) and a text/html part (-> bodyHtml, raw - Tier 1 structured
// data extraction needs it before stripping). If there's no text/plain
// alternative, bodyText falls back to the stripped HTML (see stripHtml) -
// most order-confirmation emails carry both, so this fallback path is
// rarely hit in practice.
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): ExtractedBody {
  if (!payload) return { bodyText: "", bodyHtml: "" };

  let plainText: string | null = null;
  let htmlText: string | null = null;

  function walk(part: gmail_v1.Schema$MessagePart): void {
    if (
      part.mimeType === "text/plain" &&
      part.body?.data &&
      plainText === null
    ) {
      plainText = decodeBase64Url(part.body.data);
    } else if (
      part.mimeType === "text/html" &&
      part.body?.data &&
      htmlText === null
    ) {
      htmlText = decodeBase64Url(part.body.data);
    }
    for (const child of part.parts ?? []) {
      walk(child);
    }
  }

  walk(payload);

  const bodyHtml = htmlText ?? "";
  const bodyText =
    plainText ?? (htmlText !== null ? stripHtml(htmlText) : "");
  return { bodyText, bodyHtml };
}

const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

// Intentionally minimal, not a general-purpose HTML parser - per
// CLAUDE.md's "ask before adding a dependency" this avoids pulling in an
// HTML-to-text library for what should be a rarely-hit fallback path (see
// extractBody). Good enough to keep obvious tag soup out of Claude's
// prompt; not a promise of pixel-perfect text extraction.
function stripHtml(html: string): string {
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(
    /&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g,
    (m) => HTML_ENTITIES[m] ?? m,
  );
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export async function fetchMessage(
  userId: string,
  messageId: string,
): Promise<GmailMessage> {
  const gmail = await getGmailClient(userId);

  const { data } = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = data.payload?.headers ?? undefined;

  console.log("gmail: fetched message", { userId, messageId });

  const { bodyText, bodyHtml } = extractBody(data.payload ?? undefined);

  return {
    id: messageId,
    subject: getHeader(headers, "Subject"),
    from: getHeader(headers, "From"),
    date: getHeader(headers, "Date"),
    bodyText,
    bodyHtml,
  };
}

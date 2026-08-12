# Returns OS

Web app that finds returnable purchases in a user's Gmail, tracks return
deadlines, and emails reminders before they expire.

---

## TIER 1 — Rules

1. **Plan before coding.** If the task is not trivial (< 3 steps, single file,
   no architectural decisions), enter plan mode first and get the plan approved.
2. **No secrets in code.** Everything sensitive goes in `.env.local`. Never
   commit a real token, key, or refresh token.
3. **Never log email bodies.** Email content is the most sensitive data in this
   app. Log message IDs and parse results, never raw content.
4. **Show evidence, not claims.** After a change, run the thing and show the
   output. "Should work" is not acceptable.
5. **Ask before adding a dependency.** Prefer the standard library or something
   already in `package.json`.

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js (App Router) + TypeScript |
| Styling | Tailwind CSS |
| Database | PostgreSQL |
| ORM | Prisma |
| Auth | NextAuth with Google provider (Gmail scopes) |
| Email ingest | Gmail API (`gmail.readonly`) |
| Parsing | Tiered: structured-data extraction (schema.org `Order`/`Product` markup) primary, free, no external call — **Phase 1, in progress**. LLM fallback (OpenAI `gpt-5-nano`) for emails Tier 1 misses — **deferred** until Phase 1's real hit-rate is measured against a live inbox. |
| Job queue | BullMQ + Redis |
| Outbound email | Nodemailer (Resend or SMTP in prod) |
| Hosting | Vercel (app) + Neon or Supabase (Postgres) |

---

## Architecture

```
User signs in with Google (NextAuth, Gmail readonly scope)
        ↓
Sync job enqueued (BullMQ)
        ↓
Gmail API: search for order confirmations
        ↓
Each candidate email → Tier 1: structured-data extraction (schema.org, local, free)
        ↓ (miss)
                Tier 2: LLM fallback (OpenAI gpt-5-nano) — deferred, not yet built
        ↓
Either tier's output → validated with Zod → structured JSON
        ↓
Upsert into `purchases` table with computed return deadline
        ↓
Daily cron scans for deadlines within N days
        ↓
Nodemailer sends reminder email
```

The parsing job is the interesting part. Everything else is plumbing.

---

## Data model (target)

```
User          id, email, name, createdAt
Account       NextAuth standard (holds Google refresh token)
Purchase      id, userId, retailer, itemName, orderDate, price,
              currency, orderNumber, returnDeadline, status,
              gmailMessageId (unique), rawParseJson, createdAt
Reminder      id, purchaseId, sentAt, daysBefore
SyncRun       id, userId, startedAt, finishedAt, messagesScanned,
              purchasesFound, error
```

`status`: `RETURNABLE` | `RETURNED` | `EXPIRED` | `KEEPING`

`gmailMessageId` must be unique per user — it is the idempotency key. A re-sync
must never create duplicate purchases.

---

## Parsing rules

Two tiers, tried in order. Both produce the same `ParseResult` shape and go
through the same Zod validation — nothing downstream (Purchase upsert,
retailer-policy fallback, deadline math) knows or cares which tier produced
a result.

1. **Tier 1 — structured-data extraction** (`lib/structuredData.ts`, Phase 1,
   in progress). Parses schema.org `Order`/`Product` markup (JSON-LD or
   microdata) out of the email's raw HTML. Local, free, no external call. A
   result is only accepted if every required field is present — a partial
   match returns `null` (miss), never a partial `Purchase` row.
2. **Tier 2 — LLM fallback** (deferred, not yet built; provider decided —
   OpenAI `gpt-5-nano` — but not implemented). Only runs when Tier 1 misses
   *and* an API key is configured; otherwise the candidate is logged and
   skipped, not an error. Gets the email subject, sender, date, and
   plain-text body only (HTML stripped first, whichever tier — never send
   raw HTML to a model, it wastes tokens). Structured-output JSON, validated
   the same way as Tier 1's result.
- Response must be validated with Zod before it touches the database,
  regardless of tier. A parse that fails validation is logged and skipped,
  never inserted.
- If an email is not a purchase confirmation, the result is treated as
  `isPurchase: false` and the row is skipped. Note: Tier 1 alone can't
  distinguish "not a purchase" from "a purchase with no embedded markup" —
  both just read as a miss until Tier 2 exists.
- Return window: prefer the deadline stated in the email. If absent, fall back
  to a retailer policy table. If the retailer is unknown, mark
  `returnDeadline: null` and surface it as "policy unknown" in the UI.

---

## V1 scope — do not build past this line

- [x] Google sign-in with Gmail readonly scope
- [ ] Manual "Sync now" button (no background sync yet)
- [x] Gmail search + fetch for order confirmations
- [ ] Parsing endpoint with Zod validation (tiered: structured-data extraction
      first, LLM fallback deferred — see "Parsing rules")
- [ ] Purchases list UI sorted by days remaining
- [ ] Mark as returned / keeping
- [ ] Daily cron + reminder email at 7 days and 2 days out
- [x] Retailer policy table seeded with ~8 major retailers (`prisma/seed.ts`)

**Explicitly out of scope for V1:** drop-off location maps, route optimization,
return label generation, refund tracking, mobile app, multi-account support.

---

## Current status

Project scaffold is done: Next.js/Prisma/NextAuth wired up, schema in place,
`prisma/seed.ts` seeds retailer policies + demo purchases.

Done and verified against a real connected account: item 1 (Google sign-in —
`auth.ts` has `access_type=offline`, `prompt=consent`, `gmail.readonly`
scope; note the OAuth consent screen is intentionally left in Google's
"Testing" publishing status, not published — see `auth.ts` comments — so
refresh tokens hard-expire every 7 days and sign-in may need to be repeated)
and item 3 (`lib/gmail.ts` — `searchCandidateEmails` / `fetchMessage`
implemented, `GmailNotConnectedError` normalizes both "never connected" and
"refresh token revoked/expired").

In progress: item 4 (parsing), restructured as two tiers instead of a single
Claude call — see "Parsing rules" above. **Phase 1** (current work):
`lib/structuredData.ts` (new), `GmailMessage.bodyHtml` added to
`lib/gmail.ts`, `lib/retailers.ts` implemented, `lib/parse.ts` wired to Tier
1 only. Phase 1 is being tested against a real inbox specifically to measure
the structured-data hit rate — that number decides whether Tier 2 is worth
building at all. **Tier 2** (deferred): `lib/claude.ts` remains an
unimplemented stub for now and will be renamed to `lib/openai.ts`
(`parseEmailWithOpenAI`, model `gpt-5-nano`) if/when Tier 2 gets built;
`ANTHROPIC_API_KEY` / `@anthropic-ai/sdk` are being phased out in favor of
`OPENAI_API_KEY` / `openai`, not yet changed in `.env.example` or
`package.json`.

Still stubbed, untouched: `lib/email.ts`, `daysRemainingUTC` in
`lib/dates.ts`. `/api/sync` and `/api/cron/reminders` still return 501.
`app/page.tsx` is still the default `create-next-app` placeholder.

---

## Commands

```bash
npm run dev            # local dev server
npx prisma migrate dev # apply schema changes
npx prisma studio      # inspect the database
npm run lint
npm run typecheck
```

---

## Conventions

- Server-side logic lives in `lib/`, not in route handlers. Route handlers
  parse input, call a `lib/` function, and format the response.
- Every external call (Gmail, the LLM fallback tier, SMTP) is wrapped in a
  function in `lib/` so it can be mocked in tests. Tier 1 parsing
  (`lib/structuredData.ts`) makes no external call at all — pure local
  parsing, no wrapper needed for mocking, though it still lives in `lib/`
  per the "server-side logic lives in `lib/`" rule above.
- Dates stored as UTC. Deadline math done in `lib/dates.ts`, never inline.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

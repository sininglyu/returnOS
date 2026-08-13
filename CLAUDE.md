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
| Parsing | Tiered: structured-data extraction (schema.org `Order`/`Product` markup) — **done**, kept as a free first check (tested at 0/60 hits on a real inbox — see Current status). LLM fallback (OpenAI `gpt-5-nano` via the Vercel AI SDK — `ai`'s `generateText` + `Output.object`, not the raw `openai` SDK) for emails Tier 1 misses — **done**, tested at 6/60 hits on the same real inbox — see Current status. |
| Job queue | BullMQ + Redis |
| Outbound email | Nodemailer (Resend or SMTP in prod) |
| Hosting | Vercel (app) + Neon or Supabase (Postgres) |

---

## Architecture

```
User signs in with Google (NextAuth, Gmail readonly scope)
        ↓
Sync job enqueued (BullMQ) — target architecture; V1 uses the manual
        ↓                    "Sync now" button (app/api/sync) instead, done
Gmail API: search for order confirmations
        ↓
Each candidate email → Tier 1: structured-data extraction (schema.org, local, free)
        ↓ (miss)
                Tier 2: LLM fallback (OpenAI gpt-5-nano, via Vercel AI SDK) — done, 6/60 on a real inbox
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

1. **Tier 1 — structured-data extraction** (`lib/structuredData.ts`, done).
   Parses schema.org `Order`/`Product` markup (JSON-LD or microdata) out of
   the email's raw HTML. Local, free, no external call. A result is only
   accepted if every required field is present — a partial match returns
   `null` (miss), never a partial `Purchase` row.
2. **Tier 2 — LLM fallback** (`lib/openai.ts`, OpenAI `gpt-5-nano` via the
   Vercel AI SDK — `generateText` + `Output.object({ schema })`, *not*
   `generateObject`, which is deprecated in the installed `ai` version).
   Only runs when Tier 1 misses *and* `OPENAI_API_KEY` is configured;
   otherwise the candidate is logged and skipped, not an error. Gets the
   email subject, sender, date, and plain-text body only (HTML stripped
   first, whichever tier — never send raw HTML to a model, it wastes
   tokens). Structured-output JSON, validated the same way as Tier 1's
   result. Tested at 6/60 on a real inbox — see Current status.
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
- [x] Manual "Sync now" button (no background sync yet)
- [x] Gmail search + fetch for order confirmations
- [x] Parsing endpoint with Zod validation (tiered: structured-data extraction
      first, LLM fallback — see "Parsing rules")
- [x] Purchases list UI sorted by days remaining
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

Item 4 (parsing) is restructured as two tiers instead of a single Claude
call — see "Parsing rules" above. **Tier 1 is done and tested**:
`lib/structuredData.ts` (schema.org extraction), `GmailMessage.bodyHtml` in
`lib/gmail.ts`, `lib/retailers.ts` (`getRetailerPolicy`), and `lib/parse.ts`
wired to Tier 1 → Zod → retailer-policy fallback. Tested against 60 real
Gmail-search candidates (3 pages) from a live connected inbox — result
independently reproduced, not just reported: **0 hits, 60 misses**.
Confirmed not an extractor bug (`bodyHtml` was populated, 39–132KB per
message; zero contained any `ld+json` or `schema.org` reference at all) —
this inbox's real order-confirmation emails simply don't carry schema.org
markup. Conclusion: Tier 1 stays in the codebase as a free first check (costs
nothing per email, doesn't hurt) but isn't sufficient alone — moving to
Tier 2.

**Tier 2 — done, tested against a real inbox.** `lib/claude.ts` is gone,
replaced by `lib/openai.ts` (`parseEmailWithOpenAI`) — OpenAI `gpt-5-nano`
called through the Vercel AI SDK. `lib/parse.ts` falls through to Tier 2 on
a Tier 1 miss, sharing one retailer-policy-fallback helper between both
tiers so they can't drift on that logic; a Tier 2 call is skipped (not an
error) when `OPENAI_API_KEY` is unset. `@anthropic-ai/sdk` removed from
`package.json`; `ai` + `@ai-sdk/openai` added (dependency add flagged and
confirmed before installing, per Tier 1 rule 5). `ANTHROPIC_API_KEY` →
`OPENAI_API_KEY` in `.env.example`.

Two things worth recording precisely, since both were found the hard way,
not anticipated in the original plan:

- **`generateObject` is deprecated** in the installed `ai@^7.0.64` (checked
  directly against `node_modules/ai/dist/index.d.ts`, not assumed). Current
  pattern: `generateText` with `output: Output.object({ schema })`; the
  result lands on `result.output`, not `result.object`.
- **OpenAI's structured-output mode rejects a root-level `oneOf`.** The
  first live run (all 60 candidates) failed 60/60 with a real 400
  (`"'oneOf' is not permitted"`) — `parseResultSchema` is a Zod
  `discriminatedUnion`, which compiles to a root `oneOf`. Fix:
  `lib/openai.ts` asks the model for a separate flat, all-nullable
  `tier2OutputSchema` instead, then maps that into `parseResultSchema`'s
  shape before `lib/parse.ts`'s existing (shared-with-Tier-1) Zod
  validation runs. `parseResultSchema` itself is unchanged — this is purely
  what shape the model is asked to fill in.

**Real result, 60 real Gmail-search candidates (same 3-page sample Tier 1
was tested against), `reasoningEffort: "low"`:** 6 hits, 33 correctly
classified as non-purchases, 21 that the model flagged as purchase-like but
whose extraction didn't clear `parseResultSchema` (most likely an
unparseable `orderDate`) — caught by validation and skipped, never a
partial `Purchase` row. All 6 hits sanity-checked by eye: real retailers
(5× Amazon.com, 1× GolfNow) and real item names (a book, medical supplies,
a knife set, a golf tee-time reservation, avocado oil, a cable). Combined
with Tier 1's 0/60, the two tiers together turn this inbox's 0% into a 10%
hit rate on the sample — real signal, not saturated, but no longer zero.
`npm run typecheck` and `npm run lint` both pass clean.

At the time that paragraph was written, `lib/parse.ts` wasn't wired into
`/api/sync` yet. It is now — see item 2 below, done in the same session.

**Item 2 (`/api/sync` + "Sync now" button) — done, tested against the real
connected inbox end-to-end**, not just typechecked. `auth.ts` got a
`session` callback (`session.user.id` was `undefined` before this — no
route could have known which user to sync without it; `next-auth`'s
`DefaultUser` type already declares `id?: string`, so no module
augmentation was needed). `app/api/sync/route.ts` replaced the 501 stub:
chunked (one Gmail page per call), Zod-validates its request body, skips
messages already present in `Purchase` before ever calling
`fetchMessage`/`parseCandidateEmail` (so a re-sync doesn't re-pay Tier 2
OpenAI cost on unchanged mail), upserts on `@@unique([userId,
gmailMessageId])` without letting `update` touch `status` (so a re-sync
can't silently undo a `RETURNED`/`KEEPING` choice once item 6 exists), and
has a catch-all error handler distinct from `GmailNotConnectedError` (409,
"reconnect Google") so an unexpected failure still closes out the
`SyncRun` row instead of leaving `finishedAt: null` forever.
`app/sync-button.tsx` (new) drives the page loop client-side, with a Stop
control and an approximate "`X` of `~Y` scanned" readout (`Y` = Gmail's own
`resultSizeEstimate`, which is genuinely an estimate and can shift page to
page — not a number this app computes itself).

Real run against the live connected inbox: 156 messages scanned, 26
purchases found, fully idempotent on a second click (0 new rows, dedup
skip confirmed in logs). Per-message processing started fully sequential
(~8s/message — one Gmail fetch + one Tier 2 OpenAI call each — 2.8min for
one 20-message page) and was changed to bounded concurrency (chunks of 5
via `Promise.all` in `app/api/sync/route.ts`'s `processMessage`): measured
168s → 61.8s on the same live inbox, a ~2.7x speedup, not the naive 5x —
expected, not a bug, since concurrent calls for one user still contend on
shared things (Gmail token refresh, the DB connection pool).

**Item 5 (purchases list UI) — done, verified both statically and against
the real signed-in browser render.** `lib/purchases.ts`
(`getPurchasesForUser`) sorts `status asc, returnDeadline asc nulls last` —
not deadline alone, which would put old RETURNED/EXPIRED/KEEPING rows
(large negative days-remaining) ahead of an actionable RETURNABLE row with
2 days left; confirmed against the live DB that `RETURNABLE` is
`enumsortorder 1`, so `status asc` alone already surfaces every actionable
row before resolved ones. `daysRemainingUTC` in `lib/dates.ts` implemented
(UTC-midnight whole-day diff, shared by item 5's display and item 7's
future cron). `app/purchases-list.tsx` is an async server component —
`Purchase.price` (a Prisma `Decimal`) is formatted there and never crosses
a serialization boundary to a client component. Urgency coloring
(`text-red-600` ≤2 days, `text-amber-600` ≤7 days) uses the same 7/2-day
thresholds item 7's reminder cron will use — not decorative. `rawParseJson`
is never rendered.

Verified two ways: (1) statically — typecheck/lint clean, date-math and
sort-order checked against the demo seed data and fixed inputs; (2) against
a real signed-in browser render (Playwright MCP, once connected this
session) — 26 real synced rows rendered correctly: item name, retailer,
price, status. Confirmed a real, previously-undocumented finding: all 26
rows showed `policy unknown`/`RETURNABLE` with no urgency coloring, because
every row's `returnDeadline` was `null` — not an item 5 bug, it was
`lib/retailers.ts`'s exact-match policy lookup missing `"Amazon.com"`
(what Tier 2 actually extracts) against the seed table's `"Amazon"`. **Since
fixed — see "Retailer-matching fix" below.** Also surfaced, not item 5 bugs
either: one row (`Camryn Plaza subscription`, OnlyFans) was a subscription
parsed as a returnable purchase (manually deleted from the DB at the
user's request — dedup means a future re-sync of that same Gmail message
would re-add it, since `/api/sync` only skips messages already present in
`Purchase`, so this isn't a durable fix; a `KEEPING` status once item 6
exists would be), and one row's item name (`Kitchen item`) looks like a
Tier 2 fallback rather than a real extraction — both worth a look whenever
the parsing-rules work is revisited, not blocking item 5.

**Retailer-matching fix — done, tested against the real inbox.**
`lib/retailers.ts`'s `getRetailerPolicy` was exact-match only (case
insensitive, but `"Amazon.com"` ≠ `"Amazon"`), so every real row fell
through to `policy unknown` despite Amazon being in the seed table. Fixed
with a `normalizeRetailer` helper (lowercase, trim, strip a trailing
TLD-ish suffix, collapse whitespace) and an in-memory `findMany` + compare
over the ~8-row policy table instead of a DB-side exact match — strictly
more permissive, no regression on the demo seed (GolfNow/OnlyFans/the
seed's own `"Riverside Local Boutique"` unknown-retailer case all still
correctly return `null`). Existing rows don't self-heal on a re-sync
(`/api/sync` skips already-synced messages before parsing), so a one-off
backfill script (not committed, same disposable `tsx` + `dotenv` pattern
used for the Camryn delete) recomputed `returnDeadline` for every
null-deadline row using the fixed lookup: **22 of 26 updated, 4 correctly
stayed unknown** (3 GolfNow + the seed's intentional unknown-retailer
case). Verified in the real signed-in browser render, all three expected
buckets present with correct coloring: recent Amazon orders show real
countdowns (`"3 days left"` amber, `"last day"` red — today is 2026-08-13,
Amazon's window is 30 days), older Amazon orders correctly show `"return
window passed"` in gray (not a miss — most of this inbox's Amazon orders
predate the 30-day window), and GolfNow still shows `policy unknown`.
`npm run typecheck` and `npm run lint` both pass clean.

Still stubbed, untouched: `lib/email.ts`. `/api/cron/reminders` still
returns 501. Item 6 (mark as returned/keeping) has no mutation UI yet —
item 5 is read-only.

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

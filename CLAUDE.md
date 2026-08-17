# Return OS

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
| Parsing | Tiered: structured-data extraction (schema.org `Order`/`Product` markup) — **done**, kept as a free first check (0/60 on a real inbox — this inbox's order emails carry no schema.org markup at all, confirmed not an extractor bug). LLM fallback (OpenAI `gpt-5-nano` via the Vercel AI SDK — `ai`'s `generateText` + `Output.object`, not `generateObject`, which is deprecated in the installed `ai` version) for emails Tier 1 misses — **done**, ~35% (21/60) hit rate on a real inbox — see Current status / `git log` for tuning history. |
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
                Tier 2: LLM fallback (OpenAI gpt-5-nano, via Vercel AI SDK) — done, see Stack table for current hit rate
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
   result. ~35% (21/60) hit rate on a real inbox — see Current status.
- Response must be validated with Zod before it touches the database,
  regardless of tier. A parse that fails validation is logged and skipped,
  never inserted. Both tiers' validation-failure log lines include which
  Zod field(s) failed (`lib/parse.ts`) — never the values, field names only.
- If an email is not a purchase confirmation, the result is treated as
  `isPurchase: false` and the row is skipped. Note: Tier 1 alone can't
  distinguish "not a purchase" from "a purchase with no embedded markup" —
  both just read as a miss, resolved by falling through to Tier 2.
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
- [x] Mark as returned / keeping
- [x] Daily cron + reminder email at 7 days and 2 days out
- [x] Retailer policy table seeded with ~8 major retailers (`prisma/seed.ts`)

**Explicitly out of scope for V1:** drop-off location maps, route optimization,
return label generation, refund tracking, mobile app, multi-account support.

---

## Current status

**V1 scope is fully checked off**, verified against a real connected Gmail
account throughout (not just seed data). Detailed narrative — exact test
numbers, bugs found, before/after evidence for every item above — moved
out of this always-loaded file; `git log` carries an equally thorough
commit message for each one (auth, sync, both parsing tiers, purchases
list, retailer-matching fix, mark-returned/keeping, reminders cron,
parsing hit-rate fix). This section stays a compact current-state
reference — what's built, in one place, not a diary of how it got there.

- **Auth & Gmail** (`auth.ts`, `lib/gmail.ts`) — Google sign-in,
  `gmail.readonly`. OAuth consent screen is intentionally in Google's
  "Testing" status, not published, so refresh tokens hard-expire every 7
  days and sign-in may need repeating.
- **Parsing** (`lib/structuredData.ts`, `lib/openai.ts`, `lib/parse.ts`,
  `lib/schemas.ts`) — Tier 1 (schema.org extraction) stays as a free first
  check but never hits on this inbox (0% real markup, confirmed not an
  extractor bug). Tier 2 (OpenAI `gpt-5-nano`) is the real path, ~35%
  (21/60) hit rate on a real inbox after a prompt fix (the model wasn't
  using the email's own `Date:` header as an `orderDate` fallback). Both
  tiers share one Zod validation gate (`parseResultSchema`) and one
  retailer-policy fallback; a validation failure logs which field(s)
  failed (never values) and is skipped, never a partial row. Known SDK
  gotchas: `generateObject` is deprecated in the installed `ai` version —
  use `generateText` + `Output.object`; OpenAI's structured-output mode
  rejects a root-level Zod `discriminatedUnion` (`oneOf`), so Tier 2 asks
  for a flat all-nullable shape and maps it into `parseResultSchema`
  itself. Known gap, not yet fixed: `returnDeadline` (unlike `orderDate`)
  has no parseable-date check, so a garbage value would fail later at the
  DB layer instead of at validation.
- **Sync** (`app/api/sync/route.ts`, `app/sync-button.tsx`) — chunked
  (one Gmail page/call), bounded concurrency (5x via `Promise.all`),
  dedups on `gmailMessageId` before ever calling Tier 1/2, and never lets
  a re-sync's `update` touch `status` (can't silently undo
  RETURNED/KEEPING).
- **Purchases list** (`app/purchases-list.tsx`, `lib/purchases.ts`) —
  sorted `status asc, returnDeadline asc nulls last`; urgency coloring at
  the same 7/2-day thresholds the reminder cron uses; `rawParseJson` never
  rendered.
- **Retailer-policy matching** (`lib/retailers.ts`) — normalized
  (lowercased, TLD-stripped) lookup, not exact-match, so `"Amazon.com"`
  resolves against the seeded `"Amazon"`; ~8 retailers seeded
  (`prisma/seed.ts`), unknown retailers correctly surface as "policy
  unknown."
- **Mark returned/keeping** (`app/api/purchases/[id]/route.ts` `PATCH`,
  `app/purchase-actions.tsx`) — ownership-checked in one `updateMany`
  (wrong/foreign id → 404, no existence leak). No undo back to
  `RETURNABLE` in V1, and no switching between RETURNED/KEEPING either,
  by design — a one-way choice once made.
- **Reminders cron** (`lib/reminders.ts`, `app/api/cron/reminders/route.ts`,
  `vercel.json`) — daily 14:00 UTC, `Bearer ${CRON_SECRET}` guarded. Sends
  one email per purchase for the most-urgent unsent 7/2-day threshold but
  records all due thresholds at once (a purchase that skipped straight
  past 7 days doesn't also get a stale 7-day email after its 2-day one).
  Send-then-record ordering means a failed send never burns the
  once-guard. No catch-up reminder once a deadline has fully passed — by
  design, matches the list UI's own "return window passed" treatment.

**Gmail search recall fix — done, tested against the user's real Amazon
order history, not just candidate counts.** Compared ~38 real Amazon
orders (scraped from amazon.com/your-orders) against what had actually
synced — 13 were completely missing. Traced 10 of them back through
Gmail directly (searched by order number, independent of the app's own
query) and found the dominant cause: `lib/gmail.ts`'s `SEARCH_QUERY` used
`subject:(order OR receipt OR shipped OR delivered OR confirmation)`.
Gmail's `subject:` operator does not stem — `order` never matches
`ordered`, and Amazon's actual order-confirmation email subject is
`"Ordered: ..."`. Confirmed directly against the real Gmail API: every
`"Ordered: ..."` email for every order checked returned `false` against
the old query, while that same order's `"Shipped: ..."`/`"Delivered:
..."` emails matched — meaning the parser was only ever seeing the two
least-detailed emails per order, never the one with the real item/price.
Fix: added `ordered` as its own token to the subject alternation.

Verified two ways, not assumed: (1) re-ran the exact 10 previously-`false`
messages against the fixed query — 10/10 now match, and 7/10 parse as
real hits standalone (3 — BetterBody Foods, VEVOR, Sofucor — still failed
Tier 2 classification even from their Ordered email, a separate,
unfixed issue). (2) Real end-to-end: one real "Sync now" through the
actual browser/`/api/sync` path found **39 new purchases in 120 scanned
messages** (vs. 12 found in 80 scanned before the fix, roughly a
2x jump in hit rate) and confirmed 7 of the 10 specifically-tracked
missed orders landed as real `Purchase` rows, including the largest
single miss, a $158.37 ceiling fan. Noted, not a regression: Tier 2's
classification isn't perfectly deterministic run-to-run at
`reasoningEffort: "low"` — Sofucor and BetterBody Foods failed in the
standalone check but succeeded in the real sync moments later, same
email, same query.

**Three other confirmed-but-separate root causes from the same
investigation, not fixed here:**
- Multi-item bundled shipment emails (`"X and 2 more items"`) collapse
  into one row for a single item, sometimes the wrong one at the wrong
  price — confirmed directly: one real email covering 3 separate orders
  produced a row for a 4th, unrelated item at a price matching none of
  them. `lib/openai.ts`'s prompt is working as instructed ("extract the
  first/primary item if there are several") — this is a prompt/schema
  design question, not a bug in the current code.
- No resume checkpoint across sync sessions (already known) — confirmed
  today to cause real, not just theoretical, misses: two real orders
  parse correctly right now but have never been reached by any sync,
  since every run restarts from page 1 and the candidate pool keeps
  growing as new mail arrives.
- Item-name extraction still sometimes falls back to a generic
  placeholder (`"Kitchen item"`, `"Home item"`, `"Pantry item"`) instead
  of the real product name — same known issue, unaffected by this fix.

**Still known, unaffected by this fix:**
- Zero automated test coverage — everything verified via live/manual
  testing (Playwright, real Gmail account, disposable diagnostic scripts).
- Never deployed to production — the Vercel Cron trigger, real SMTP, and
  the OAuth "Testing"-mode limitation are all unverified outside
  `localhost`.

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

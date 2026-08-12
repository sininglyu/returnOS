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
| Parsing | Claude API (`claude-sonnet-4-6`) |
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
Each candidate email → Claude API → structured JSON
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

- Claude gets the email subject, sender, date, and plain-text body (HTML
  stripped first — do not send raw HTML, it wastes tokens).
- Prompt must demand **JSON only**, no prose, no markdown fences.
- Response must be validated with Zod before it touches the database. A parse
  that fails validation is logged and skipped, never inserted.
- If the email is not a purchase confirmation, the model returns
  `{ "isPurchase": false }` and the row is skipped.
- Return window: prefer the deadline stated in the email. If absent, fall back
  to a retailer policy table. If the retailer is unknown, mark
  `returnDeadline: null` and surface it as "policy unknown" in the UI.

---

## V1 scope — do not build past this line

- [ ] Google sign-in with Gmail readonly scope
- [ ] Manual "Sync now" button (no background sync yet)
- [ ] Gmail search + fetch for order confirmations
- [ ] Claude parsing endpoint with Zod validation
- [ ] Purchases list UI sorted by days remaining
- [ ] Mark as returned / keeping
- [ ] Daily cron + reminder email at 7 days and 2 days out
- [ ] Retailer policy table seeded with ~8 major retailers

**Explicitly out of scope for V1:** drop-off location maps, route optimization,
return label generation, refund tracking, mobile app, multi-account support.

---

## Current status

Project scaffold is done: Next.js/Prisma/NextAuth wired up, schema in place,
`prisma/seed.ts` seeds retailer policies + demo purchases. All business logic
is stubbed (`lib/gmail.ts`, `lib/claude.ts`, `lib/parse.ts`,
`lib/retailers.ts`, `lib/email.ts`, `daysRemainingUTC` in `lib/dates.ts`) and
the `/api/sync` and `/api/cron/reminders` routes return 501. `app/page.tsx`
is still the default `create-next-app` placeholder.

Next task: finish item 1 (Google sign-in scopes — `auth.ts` needs
`access_type=offline`, `prompt=consent`, and the Gmail readonly scope
confirmed) and item 3 (`lib/gmail.ts`), since most other stubs depend on it.

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
- Every external call (Gmail, Claude, SMTP) is wrapped in a function in
  `lib/` so it can be mocked in tests.
- Dates stored as UTC. Deadline math done in `lib/dates.ts`, never inline.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

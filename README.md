# Returns OS

Web app that finds returnable purchases in a user's Gmail, tracks return
deadlines, and emails reminders before they expire. See `CLAUDE.md` for full
architecture, data model, and V1 scope.

## Stack

Next.js (App Router) + TypeScript, Tailwind CSS, PostgreSQL via Prisma,
NextAuth (Google, Gmail readonly scope), tiered parsing (schema.org
extraction, then OpenAI `gpt-5-nano` via the Vercel AI SDK), Nodemailer
for reminder email.

## Setup

1. Copy `.env.example` to `.env.local` and fill in real values (Postgres URLs,
   Google OAuth client, `OPENAI_API_KEY`, outbound email transport,
   `CRON_SECRET`). Never commit `.env.local`.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Apply the schema and seed dev data (retailer policy table + a demo user
   with sample purchases):
   ```bash
   npx prisma migrate dev
   npx prisma db seed
   ```
4. Run the dev server:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000).

## Commands

```bash
npm run dev            # local dev server
npx prisma migrate dev # apply schema changes
npx prisma studio      # inspect the database
npm run lint
npm run typecheck
```

## Status

Scaffold and data model are in place; Gmail sync, Claude parsing, the
purchases UI, and the reminder cron are not yet implemented. See CLAUDE.md's
"Current status" and V1 checklist for what's next.

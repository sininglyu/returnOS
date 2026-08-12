// Prisma 7 config. Connection URLs no longer live in schema.prisma — this
// file drives `prisma migrate` / `prisma studio`, and the app's runtime
// connection is separately configured via the driver adapter in lib/db.ts.
//
// DIRECT_URL (not DATABASE_URL) is used here deliberately: migrations need
// a non-pooled connection (advisory locks, schema changes), while the app
// itself connects through the pooled DATABASE_URL at runtime. Same split
// the original schema's `directUrl` field expressed, just relocated.

// Plain `dotenv` (unlike Next.js) only reads `.env` by default — point it at
// `.env.local` explicitly so this stays the single source of truth for
// secrets (CLAUDE.md: "Everything sensitive goes in .env.local").
import { config } from "dotenv";
config({ path: ".env.local" });

import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DIRECT_URL"),
  },
});

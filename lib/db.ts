// PrismaClient singleton. Serverless functions can create a new client per
// invocation and exhaust Postgres connections; caching on `globalThis` in dev
// (hot reload) and reusing a single instance in prod avoids that.
//
// Prisma 7 requires an explicit driver adapter at runtime (schema.prisma no
// longer carries a connection url). DATABASE_URL should point at a pooled
// connection; DIRECT_URL (non-pooled) is used only by `prisma migrate`, via
// prisma.config.ts — see that file for the pooled/direct split.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

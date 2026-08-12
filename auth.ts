// Auth.js v5 config. Google provider with Gmail readonly scope + offline
// access (so we get a refresh_token, stored on the Account row by the
// Prisma adapter) per CLAUDE.md item 1.
//
// session.strategy is "database" by default whenever an adapter is
// configured (see @auth/core/lib/init.js) - set explicitly here so it's not
// left to an implicit default. Note this is orthogonal to refresh_token
// persistence: linkAccount() (which writes the Account row) runs off the
// adapter regardless of session strategy. Item 3's cron job reads the
// refresh_token straight from the Account table, never from a session.
//
// access_type=offline + prompt=consent guarantee Google actually issues a
// refresh_token on first link. Passing a custom `authorization.params`
// overrides the provider's default scope entirely, so `openid email
// profile` has to be restated alongside gmail.readonly, not just appended.
//
// Repeat sign-ins never touch an existing Account row: the Prisma adapter's
// linkAccount is `prisma.account.create` only (no update/upsert), and
// handle-login.js skips linkAccount entirely once getUserByAccount finds a
// match. So whatever refresh_token was captured on the very first consent
// is what persists - see the plan doc for the operational implications.

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      authorization: {
        params: {
          scope:
            "openid email profile https://www.googleapis.com/auth/gmail.readonly",
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
});

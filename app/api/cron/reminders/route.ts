// Daily cron target (item 7). Configure in vercel.json (crons) to hit this
// route once a day. Guarded by CRON_SECRET so it can't be triggered
// externally.

import { NextRequest, NextResponse } from "next/server";

// TODO(item 7): verify Authorization header against CRON_SECRET -> scan
// Purchases with returnDeadline within 7 or 2 days (lib/dates.ts) that
// don't already have a matching Reminder row (Reminder is unique on
// [purchaseId, daysBefore], so this is the send-once guard) -> send via
// lib/email.sendReminderEmail -> insert the Reminder row.

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ error: "not implemented" }, { status: 501 });
}

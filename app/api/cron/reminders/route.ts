// Daily cron target (item 7). Configured in vercel.json (crons) to hit
// this route once a day. Guarded by CRON_SECRET so it can't be triggered
// externally.

import { NextRequest, NextResponse } from "next/server";
import { processDueReminders } from "@/lib/reminders";

// Same rationale as app/api/sync/route.ts: worst case is one sequential
// SMTP send per due purchase, comfortably inside 300s at V1 volume.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const summary = await processDueReminders();
    return NextResponse.json(summary);
  } catch (err) {
    console.log("reminders: run failed", {
      errorType: err instanceof Error ? err.name : typeof err,
    });
    return NextResponse.json({ error: "reminders-failed" }, { status: 500 });
  }
}

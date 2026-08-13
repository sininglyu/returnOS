// V1 item 6: mark a purchase RETURNED or KEEPING. Only ever sets one of
// those two - RETURNABLE (creation default) and EXPIRED (item 7's future
// cron) are system-managed, not reachable through this endpoint. Route
// handler stays thin (CLAUDE.md convention): parse input, call a lib/
// function, format the response - same shape as app/api/sync/route.ts.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { updatePurchaseStatus } from "@/lib/purchases";

const requestSchema = z.object({
  status: z.enum(["RETURNED", "KEEPING"]),
});

export async function PATCH(
  request: NextRequest,
  { params }: RouteContext<"/api/purchases/[id]">,
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const parsedBody = requestSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "invalid request body" },
      { status: 400 },
    );
  }

  const updated = await updatePurchaseStatus(userId, id, parsedBody.data.status);
  if (!updated) {
    // Covers both "no such purchase" and "not this user's purchase" - same
    // response either way, no existence leak.
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({ status: parsedBody.data.status });
}

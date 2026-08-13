"use client";

// V1 item 2: manual "Sync now" button. Drives /api/sync in a loop, one
// Gmail page per call, until the server reports done: true. Colocated with
// app/page.tsx rather than in a components/ dir - no such dir exists yet
// to justify one for a single component.

import { useState } from "react";

interface SyncResponse {
  syncRunId: string;
  nextPageToken: string | null;
  done: boolean;
  messagesScanned: number;
  purchasesFound: number;
}

type Status =
  | { kind: "idle" }
  | { kind: "running"; messagesScanned: number; purchasesFound: number }
  | { kind: "done"; messagesScanned: number; purchasesFound: number }
  | { kind: "not-connected" }
  | { kind: "error" };

export function SyncButton() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const running = status.kind === "running";

  async function handleClick() {
    setStatus({ kind: "running", messagesScanned: 0, purchasesFound: 0 });

    let pageToken: string | null = null;
    let syncRunId: string | null = null;

    // Client-side guard only (the `running` disabled-state above) against
    // double-clicks - no server-side lock. Fine for a single-user manual
    // button in V1.
    for (;;) {
      let res: Response;
      try {
        res = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pageToken, syncRunId }),
        });
      } catch {
        setStatus({ kind: "error" });
        return;
      }

      if (res.status === 409) {
        setStatus({ kind: "not-connected" });
        return;
      }
      if (!res.ok) {
        setStatus({ kind: "error" });
        return;
      }

      const data: SyncResponse = await res.json();
      pageToken = data.nextPageToken;
      syncRunId = data.syncRunId;

      if (data.done) {
        setStatus({
          kind: "done",
          messagesScanned: data.messagesScanned,
          purchasesFound: data.purchasesFound,
        });
        return;
      }

      setStatus({
        kind: "running",
        messagesScanned: data.messagesScanned,
        purchasesFound: data.purchasesFound,
      });
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button type="button" onClick={handleClick} disabled={running} className="underline">
        {running ? "Syncing..." : "Sync now"}
      </button>

      {(status.kind === "running" || status.kind === "done") && (
        <p className="text-sm text-gray-500">
          {status.messagesScanned} scanned, {status.purchasesFound} found
        </p>
      )}
      {status.kind === "not-connected" && (
        <p className="text-sm text-red-600">
          Google connection expired or was revoked - sign out and sign back
          in to reconnect.
        </p>
      )}
      {status.kind === "error" && (
        <p className="text-sm text-red-600">Sync failed - try again.</p>
      )}
    </div>
  );
}

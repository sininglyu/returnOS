"use client";

// V1 item 2: manual "Sync now" button. Drives /api/sync in a loop, one
// Gmail page per call, until the server reports done: true or the user
// stops it. Colocated with app/page.tsx rather than in a components/ dir -
// no such dir exists yet to justify one for a single component.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface SyncResponse {
  syncRunId: string;
  nextPageToken: string | null;
  done: boolean;
  messagesScanned: number;
  purchasesFound: number;
  resultSizeEstimate: number | null;
}

type Status =
  | { kind: "idle" }
  | {
      kind: "running" | "stopped" | "done";
      messagesScanned: number;
      purchasesFound: number;
      resultSizeEstimate: number | null;
    }
  | { kind: "not-connected" }
  | { kind: "error" };

export function SyncButton() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Ref, not state: the loop below reads this synchronously between
  // awaits, and a state read inside that closure would see a stale value
  // from when the loop started, not the click that happened mid-loop.
  const stopRequested = useRef(false);

  const running = status.kind === "running";

  async function handleClick() {
    stopRequested.current = false;
    setStatus({
      kind: "running",
      messagesScanned: 0,
      purchasesFound: 0,
      resultSizeEstimate: null,
    });

    let pageToken: string | null = null;
    let syncRunId: string | null = null;

    // Client-side guard only (the `running` disabled-state below) against
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
          resultSizeEstimate: data.resultSizeEstimate,
        });
        // Re-run the server-rendered PurchasesList in place so new rows
        // show up without a manual reload. Not called on error/not-connected
        // below - nothing new was necessarily written there.
        router.refresh();
        return;
      }

      if (stopRequested.current) {
        // The page that was already in flight above still ran server-side
        // and its results are already saved - stopping here just means no
        // further pages get requested. Same effect as closing the tab
        // mid-sync; the SyncRun row is left with finishedAt: null, same as
        // that case, and a later "Sync now" click starts a fresh run
        // rather than resuming this one (no resume UI in V1).
        setStatus({
          kind: "stopped",
          messagesScanned: data.messagesScanned,
          purchasesFound: data.purchasesFound,
          resultSizeEstimate: data.resultSizeEstimate,
        });
        router.refresh();
        return;
      }

      setStatus({
        kind: "running",
        messagesScanned: data.messagesScanned,
        purchasesFound: data.purchasesFound,
        resultSizeEstimate: data.resultSizeEstimate,
      });
    }
  }

  function handleStop() {
    stopRequested.current = true;
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleClick}
          disabled={running}
          className="inline-flex h-8 items-center gap-2 rounded-md bg-accent px-3.5 text-[13px] font-semibold text-white shadow-sm hover:bg-accent-2 disabled:cursor-not-allowed disabled:opacity-70"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-white/90" aria-hidden="true" />
          {running ? "Syncing…" : "Sync now"}
        </button>
        {running && (
          <button
            type="button"
            onClick={handleStop}
            className="inline-flex h-8 items-center rounded-md border border-border-strong bg-surface px-3 text-[13px] font-semibold text-foreground hover:border-accent hover:text-accent"
          >
            Stop
          </button>
        )}
      </div>

      {(status.kind === "running" ||
        status.kind === "done" ||
        status.kind === "stopped") && (
        <p className="font-mono text-xs tabular-nums text-ink-2">
          {status.messagesScanned}
          {status.resultSizeEstimate !== null
            ? ` of ~${status.resultSizeEstimate}`
            : ""}{" "}
          scanned, {status.purchasesFound} found
          {status.kind === "stopped" && " (stopped)"}
        </p>
      )}
      {status.kind === "not-connected" && (
        <p className="text-xs text-crit">
          Google connection expired or was revoked — sign out and sign back
          in to reconnect.
        </p>
      )}
      {status.kind === "error" && <p className="text-xs text-crit">Sync failed — try again.</p>}
    </div>
  );
}

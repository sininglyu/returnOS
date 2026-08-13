"use client";

// V1 item 6: mark-as-returned/keeping controls. Colocated with
// app/purchases-list.tsx rather than a components/ dir, same reasoning as
// sync-button.tsx - no such dir exists yet to justify one.
//
// No undo in V1: once a row is RETURNED or KEEPING this renders nothing -
// no way back to RETURNABLE, no switching between RETURNED/KEEPING either.
// The API technically permits calling again with the other value, but
// nothing in this UI exposes that, so it isn't a feature.

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PurchaseStatus } from "@prisma/client";

type State = "idle" | "saving" | "error";

const CONFIRM_TEXT: Record<"RETURNED" | "KEEPING", string> = {
  RETURNED: "Mark this as returned? This can't be undone here.",
  KEEPING: "Mark this as keeping? This can't be undone here.",
};

export function PurchaseActions({
  purchaseId,
  status,
}: {
  purchaseId: string;
  status: PurchaseStatus;
}) {
  const router = useRouter();
  const [state, setState] = useState<State>("idle");

  if (status === "RETURNED" || status === "KEEPING") return null;

  async function markAs(next: "RETURNED" | "KEEPING") {
    if (!window.confirm(CONFIRM_TEXT[next])) return;

    setState("saving");
    try {
      const res = await fetch(`/api/purchases/${purchaseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        setState("error");
        return;
      }
      // Re-run the server-rendered PurchasesList in place, same pattern
      // sync-button.tsx uses - no revalidatePath, no polling.
      router.refresh();
    } catch {
      setState("error");
    }
  }

  const saving = state === "saving";

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => markAs("RETURNED")}
          disabled={saving}
          className="text-xs underline"
        >
          Mark returned
        </button>
        <button
          type="button"
          onClick={() => markAs("KEEPING")}
          disabled={saving}
          className="text-xs underline"
        >
          Keeping it
        </button>
      </div>
      {state === "error" && (
        <p className="text-xs text-red-600">Failed - try again.</p>
      )}
    </div>
  );
}

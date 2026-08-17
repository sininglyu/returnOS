// V1 checklist item 1: signed-in/out shell. The purchases UI (item 5) is
// app/purchases-list.tsx; the manual sync control (item 2) is
// app/sync-button.tsx.

import { auth, signIn, signOut } from "@/auth";
import { SyncButton } from "./sync-button";
import { PurchasesList } from "./purchases-list";

function BrandMark() {
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent text-white shadow-sm">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <path d="M9 14 4 9l5-5" />
        <path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H8" />
      </svg>
    </span>
  );
}

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 p-16">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <h1 className="text-base font-semibold tracking-tight text-foreground">Return OS</h1>
        </div>
        <p className="text-sm text-ink-2">Return windows, watched.</p>
        <form
          action={async () => {
            "use server";
            await signIn("google");
          }}
        >
          <button
            type="submit"
            className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-semibold text-white shadow-sm hover:bg-accent-2"
          >
            Sign in with Google
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6 sm:p-10">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <div>
            <h1 className="text-[15px] font-semibold leading-tight tracking-tight text-foreground">
              Return OS
            </h1>
            <p className="text-[11px] leading-tight text-ink-3">{session.user.email}</p>
          </div>
        </div>
        <form
          action={async () => {
            "use server";
            await signOut();
          }}
        >
          <button
            type="submit"
            className="text-xs text-ink-2 underline decoration-border-strong underline-offset-2 hover:text-foreground"
          >
            Sign out
          </button>
        </form>
      </div>

      <SyncButton />

      {session.user.id && <PurchasesList userId={session.user.id} />}
    </div>
  );
}

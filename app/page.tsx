// V1 checklist item 1: minimal signed-in/out state. The real purchases UI
// (item 5) replaces this once sync + parsing exist.

import { auth, signIn, signOut } from "@/auth";
import { SyncButton } from "./sync-button";

export default async function Home() {
  const session = await auth();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-16">
      <h1 className="text-xl font-semibold">Returns OS</h1>

      {session?.user ? (
        <>
          <p>Signed in as {session.user.email}</p>
          <form
            action={async () => {
              "use server";
              await signOut();
            }}
          >
            <button type="submit" className="underline">
              Sign out
            </button>
          </form>
          <SyncButton />
        </>
      ) : (
        <form
          action={async () => {
            "use server";
            await signIn("google");
          }}
        >
          <button type="submit" className="underline">
            Sign in with Google
          </button>
        </form>
      )}
    </div>
  );
}

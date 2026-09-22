import { redirect } from "next/navigation";

import { getMembership, getUser } from "@/lib/auth";
import { signOut } from "@/app/login/actions";

export const metadata = { title: "Waiting for access" };
export const dynamic = "force-dynamic";

export default async function PendingPage() {
  const user = await getUser();
  if (!user) {
    redirect("/login");
  }

  if (await getMembership()) {
    redirect("/");
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">
        Waiting for access
      </h1>
      <p className="text-sm text-black/60 dark:text-white/60">
        Your account exists, but it has not been added to a workspace yet. Ask
        an owner to add {user.email} and then reload this page.
      </p>
      <form action={signOut}>
        <button className="text-sm underline">Sign out</button>
      </form>
    </main>
  );
}

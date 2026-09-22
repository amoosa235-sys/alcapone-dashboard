import Link from "next/link";

import { signOut } from "@/app/login/actions";
import { requireMembership } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { TICKET_STATUSES } from "@/types/database";

export const dynamic = "force-dynamic";

/**
 * The signed-in home. It is deliberately thin: the real ticket list, detail
 * view and reply box are step 6. What it proves today is that a signed-in
 * user reads their own tenant's rows and nobody else's.
 */
export default async function Home() {
  const { user, membership } = await requireMembership();
  const counts = await countTicketsByStatus();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-10 px-6 py-16">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {membership.tenantName}
          </h1>
          <p className="text-sm text-black/60 dark:text-white/60">
            Signed in as {user.email} &middot; {membership.role}
          </p>
        </div>
        <form action={signOut}>
          <button className="text-sm underline">Sign out</button>
        </form>
      </header>

      <section className="grid grid-cols-3 gap-4">
        {TICKET_STATUSES.map((status) => (
          <div
            key={status}
            className="rounded-lg border border-black/10 p-5 dark:border-white/15"
          >
            <div className="text-2xl font-semibold tabular-nums">
              {counts[status]}
            </div>
            <div className="mt-1 text-sm capitalize text-black/60 dark:text-white/60">
              {status}
            </div>
          </div>
        ))}
      </section>

      <p className="text-sm text-black/60 dark:text-white/60">
        Tickets arrive from the channels you connect. Nothing is connected out
        of the box, so start there.
      </p>

      <div className="flex items-center gap-4">
        <Link
          href="/channels"
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background"
        >
          Connect a channel
        </Link>
        <Link href="/status" className="text-xs underline">
          Pipeline check
        </Link>
      </div>
    </main>
  );
}

/**
 * Counts run under the caller's session, so RLS is what scopes them to the
 * user's tenant. There is deliberately no tenant_id filter here: if one were
 * needed, the policies would not be doing their job.
 */
async function countTicketsByStatus() {
  const supabase = await createClient();

  const results = await Promise.all(
    TICKET_STATUSES.map(async (status) => {
      const { count } = await supabase
        .from("tickets")
        .select("id", { head: true, count: "exact" })
        .eq("status", status);
      return [status, count ?? 0] as const;
    }),
  );

  return Object.fromEntries(results) as Record<
    (typeof TICKET_STATUSES)[number],
    number
  >;
}

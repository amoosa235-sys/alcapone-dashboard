import Link from "next/link";

import { signOut } from "@/app/login/actions";
import { requireMembership } from "@/lib/auth";
import { countTicketsByStatus } from "@/lib/tickets/queries";
import { STATUS_BLURBS, STATUS_LABELS } from "@/lib/tickets/view";
import { TICKET_STATUSES } from "@/types/database";

export const dynamic = "force-dynamic";

/**
 * The signed-in home: the three piles, and a way into each of them.
 *
 * The counts run under the caller's session, so row level security is what
 * scopes them to their workspace. There is deliberately no tenant_id filter:
 * if one were needed, the policies would not be doing their job.
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
          <Link
            key={status}
            href={`/tickets?status=${status}`}
            className="rounded-lg border border-black/10 p-5 hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.04]"
          >
            <div className="text-2xl font-semibold tabular-nums">
              {counts[status]}
            </div>
            <div className="mt-1 text-sm text-black/60 dark:text-white/60">
              {STATUS_LABELS[status]}
            </div>
          </Link>
        ))}
      </section>

      <p className="text-sm text-black/60 dark:text-white/60">
        {counts.unopened > 0
          ? STATUS_BLURBS.unopened
          : "Tickets arrive from the channels you connect."}
      </p>

      <div className="flex items-center gap-4">
        <Link
          href="/tickets"
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background"
        >
          Open the inbox
        </Link>
        <Link href="/channels" className="text-xs underline">
          Channels
        </Link>
        <Link href="/status" className="text-xs underline">
          Pipeline check
        </Link>
      </div>
    </main>
  );
}

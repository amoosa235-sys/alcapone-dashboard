import Link from "next/link";

import { requireMembership } from "@/lib/auth";
import { listSavedReplies } from "@/lib/tickets/queries";

import { deleteSavedReply } from "./actions";
import { SavedReplyForm } from "./saved-reply-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Saved replies" };

/**
 * The answers the team gives every day, written once. Each one is offered
 * in the reply box on every ticket, filled in from that ticket.
 */
export default async function SavedRepliesPage() {
  await requireMembership();
  const replies = await listSavedReplies();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-xs underline">
          Back to the dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Saved replies</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Answers you give every day. Pick one from the reply box on any ticket.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Add one</h2>
        <SavedReplyForm />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Saved</h2>
        {replies.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {replies.map((reply) => (
              <li
                key={reply.id}
                className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 dark:border-white/15"
              >
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-sm font-medium">{reply.title}</span>
                  <form action={deleteSavedReply}>
                    <input type="hidden" name="id" value={reply.id} />
                    <button className="text-xs underline">Remove</button>
                  </form>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-black/70 dark:text-white/70">
                  {reply.body}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

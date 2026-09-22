"use client";

import { useActionState, useState } from "react";

import { EMPTY_TICKET_STATE, composeReply } from "./actions";

/**
 * Writing a reply, and separately deciding to send it.
 *
 * Claude can fill the box; only a person can empty it into a customer's
 * inbox. Those are two different buttons posting two different intents, and
 * the send intent is produced by nothing else on the page. Pressing Enter in
 * the box does not submit anything, so there is no keystroke that sends.
 *
 * When the channel cannot carry a reply, the words are still worth writing:
 * the box stays, and only sending is off.
 */
export function ReplyComposer({
  ticketId,
  initialBody,
  draftIsClaudes,
  blockedReason,
}: {
  ticketId: string;
  initialBody: string;
  /** True when what is in the box arrived from Claude and is untouched. */
  draftIsClaudes: boolean;
  /** Why sending is impossible on this ticket, or null when it is possible. */
  blockedReason: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    composeReply,
    EMPTY_TICKET_STATE,
  );
  const [body, setBody] = useState(initialBody);

  // The box is typed into here but also written to from the server, by asking
  // Claude for a draft, saving, or throwing one away. When the stored draft
  // changes underneath, the stored draft wins: an agent who pressed "draft
  // one" is waiting to see Claude's words, not the empty box they left.
  const [storedBody, setStoredBody] = useState(initialBody);
  if (initialBody !== storedBody) {
    setStoredBody(initialBody);
    setBody(initialBody);
  }

  const empty = body.trim().length === 0;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="ticketId" value={ticketId} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor="reply-body" className="text-sm font-medium">
          Reply
        </label>
        <button
          type="submit"
          name="intent"
          value="draft"
          disabled={pending}
          className="rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/5"
        >
          {pending ? "Working…" : "Draft one with Claude"}
        </button>
      </div>

      <textarea
        id="reply-body"
        name="body"
        rows={9}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Write the reply, or have Claude start it."
        className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm leading-relaxed dark:border-white/20"
      />

      {draftIsClaudes && !empty ? (
        <p className="text-xs text-black/60 dark:text-white/60">
          These are Claude&rsquo;s words, not yours yet. Read them before you
          send.
        </p>
      ) : null}

      {blockedReason ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed">
          {blockedReason}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          name="intent"
          value="save"
          disabled={pending || empty}
          className="rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/5"
        >
          Save as a draft
        </button>

        <button
          type="submit"
          name="intent"
          value="discard"
          disabled={pending}
          className="rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/5"
        >
          Throw it away
        </button>

        <button
          type="submit"
          name="intent"
          value="send"
          disabled={pending || empty || blockedReason !== null}
          className="ml-auto rounded-md bg-foreground px-4 py-1.5 text-sm font-medium text-background disabled:opacity-40"
        >
          Send to the customer
        </button>
      </div>

      {state.error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>
      ) : null}
      {state.notice ? (
        <p className="text-sm text-black/70 dark:text-white/70">
          {state.notice}
        </p>
      ) : null}
    </form>
  );
}

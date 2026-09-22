"use client";

import { useActionState } from "react";

import { TEMPLATE_PLACEHOLDERS } from "@/lib/replies/templates";

import { createSavedReply, type SavedReplyState } from "./actions";

const EMPTY: SavedReplyState = { error: null, notice: null };

export function SavedReplyForm() {
  const [state, formAction, pending] = useActionState(createSavedReply, EMPTY);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Name</span>
        <input
          name="title"
          maxLength={120}
          placeholder="Where is my order"
          className="rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Reply</span>
        <textarea
          name="body"
          rows={7}
          maxLength={5000}
          placeholder={"Hi {first_name},\n\nThanks for getting in touch about order {order}…"}
          className="rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm leading-relaxed dark:border-white/20"
        />
      </label>
      <p className="text-xs text-black/50 dark:text-white/50">
        These are filled in from the ticket:{" "}
        {TEMPLATE_PLACEHOLDERS.map((placeholder) => `{${placeholder.key}} (${placeholder.label.toLowerCase()})`).join(", ")}.
        Anything the ticket does not know stays in brackets for you to fill before sending.
      </p>
      {state.error ? <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p> : null}
      {state.notice ? <p className="text-sm text-black/70 dark:text-white/70">{state.notice}</p> : null}
      <div>
        <button
          disabled={pending}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save it"}
        </button>
      </div>
    </form>
  );
}

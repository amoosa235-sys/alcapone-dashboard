"use client";

import { useActionState } from "react";

import { EMPTY_RUN_STATE, runJobsNow } from "./actions";

/** Kicks the mailbox check and classification without waiting for the hour. */
export function RunJobsButton() {
  const [state, formAction, pending] = useActionState(
    runJobsNow,
    EMPTY_RUN_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <button
          disabled={pending}
          className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/20"
        >
          {pending ? "Checking…" : "Check mailboxes now"}
        </button>
        <span className="text-xs text-black/45 dark:text-white/45">
          Also runs on its own once a day.
        </span>
      </div>

      {state.summary ? (
        <p role="status" className="text-xs text-black/60 dark:text-white/60">
          {state.summary}
        </p>
      ) : null}

      {state.error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

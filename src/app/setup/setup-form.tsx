"use client";

import { useActionState } from "react";

import { claimWorkspace, type SetupFormState } from "./actions";

const EMPTY: SetupFormState = { error: null };

export function SetupForm() {
  const [state, action, pending] = useActionState(claimWorkspace, EMPTY);

  return (
    <form action={action} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Company name</span>
        <input
          name="name"
          required
          autoFocus
          placeholder="Acme Supplies"
          className="rounded-md border border-black/15 px-3 py-2 dark:border-white/20"
        />
      </label>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}

      <button
        disabled={pending}
        className="mt-2 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create workspace"}
      </button>
    </form>
  );
}

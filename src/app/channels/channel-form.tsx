"use client";

import { useActionState } from "react";

import type { ChannelSpec } from "@/lib/channels/specs";

import { EMPTY_SAVE_STATE, saveChannel } from "./actions";

/**
 * The credential form for one account type.
 *
 * Fields come from the spec, so this renders whatever a channel asks for
 * without knowing anything about it. For a channel whose integration is not
 * built, the notice at the top is deliberately the first thing read: these
 * are real credentials being stored against something that cannot use them
 * yet, and nobody should walk away thinking the channel is live.
 */
export function ChannelForm({ spec }: { spec: ChannelSpec }) {
  const [state, formAction, pending] = useActionState(
    saveChannel,
    EMPTY_SAVE_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="type" value={spec.key} />

      <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed">
        <strong className="font-semibold">Saved, not connected.</strong>{" "}
        {spec.name} has no integration behind it yet. What you enter here is
        stored and waiting, and no messages will arrive from it until that part
        is built.
      </p>

      {spec.fields.map((field) => (
        <label key={field.name} className="flex flex-col gap-1 text-xs">
          <span className="font-medium">
            {field.label}
            {field.optional ? (
              <span className="font-normal text-black/40 dark:text-white/40">
                {" "}
                (optional)
              </span>
            ) : null}
          </span>
          <input
            name={field.name}
            type={field.secret ? "password" : "text"}
            placeholder={field.placeholder}
            autoComplete={field.secret ? "new-password" : "off"}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20"
          />
          {field.help ? (
            <span className="text-black/45 dark:text-white/45">
              {field.help}
            </span>
          ) : null}
        </label>
      ))}

      <p className="text-xs text-black/45 dark:text-white/45">
        Where to find these: {spec.where}
      </p>

      {state.error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      {state.saved ? (
        <p role="status" className="text-xs text-green-700 dark:text-green-400">
          {state.saved}
        </p>
      ) : null}

      <button
        disabled={pending}
        className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/20"
      >
        {pending ? "Saving…" : `Save ${spec.name}`}
      </button>
    </form>
  );
}

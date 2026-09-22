"use client";

import { useActionState, type ReactNode } from "react";

import { EMPTY_TICKET_STATE, type TicketActionState } from "./state";

type Button = {
  label: string;
  /** Posted as name=value, so one form can offer several choices. */
  name?: string;
  value?: string;
  primary?: boolean;
};

/**
 * A small form around one ticket action: hidden fields, whatever inputs are
 * passed in, a row of buttons, and the action's answer underneath.
 *
 * Every ticket action re-checks who is asking on the server, so this is
 * only presentation.
 */
export function ActionForm({
  action,
  hidden,
  buttons,
  children,
  className,
}: {
  action: (previous: TicketActionState, formData: FormData) => Promise<TicketActionState>;
  hidden: Record<string, string>;
  buttons: Button[];
  children?: ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_TICKET_STATE);

  return (
    <form action={formAction} className={className ?? "flex flex-col gap-2"}>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      <div className="flex flex-wrap gap-2">
        {buttons.map((button) => (
          <button
            key={`${button.name ?? ""}:${button.value ?? button.label}`}
            name={button.name}
            value={button.value}
            disabled={pending}
            className={
              button.primary
                ? "rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
                : "rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/5"
            }
          >
            {button.label}
          </button>
        ))}
      </div>
      {state.error ? <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p> : null}
      {state.notice ? <p className="text-sm text-black/70 dark:text-white/70">{state.notice}</p> : null}
    </form>
  );
}

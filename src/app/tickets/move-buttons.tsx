"use client";

import { useActionState } from "react";

import { EMPTY_TICKET_STATE, moveTicket } from "./actions";
import { movesFrom, type TicketStatus } from "@/lib/tickets/view";

/**
 * The three piles, as buttons.
 *
 * Which moves exist comes from one place so the page and the action cannot
 * disagree, and the server checks the move again against the ticket as it
 * stands. This is only what an agent is offered.
 */
export function MoveButtons({
  ticketId,
  status,
}: {
  ticketId: string;
  status: TicketStatus;
}) {
  const [state, formAction, pending] = useActionState(
    moveTicket,
    EMPTY_TICKET_STATE,
  );

  const moves = movesFrom(status);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="ticketId" value={ticketId} />

      <div className="flex flex-wrap gap-2">
        {moves.map((move, index) => (
          <button
            key={move.to}
            name="to"
            value={move.to}
            disabled={pending}
            className={
              index === 0
                ? "rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
                : "rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/5"
            }
          >
            {move.label}
          </button>
        ))}
      </div>

      {state.error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>
      ) : null}
    </form>
  );
}

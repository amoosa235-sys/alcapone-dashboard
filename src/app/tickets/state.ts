/**
 * What a ticket action answers with. Kept out of actions.ts because a
 * "use server" file may only export async functions.
 */
export type TicketActionState = {
  error: string | null;
  notice: string | null;
  /** Set when asking for a draft would throw away words a person wrote. */
  confirmReplace?: boolean;
};

export const EMPTY_TICKET_STATE: TicketActionState = {
  error: null,
  notice: null,
};

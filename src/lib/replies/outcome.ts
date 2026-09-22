/**
 * A send that was claimed but never finished.
 *
 * The send path marks a reply 'sending' before it talks to Microsoft, which
 * is what stops a double press sending twice. If the server is cut off after
 * that (a timeout, a deploy), the row never moves again. After this long a
 * reply still marked 'sending' is not on its way; nobody knows whether it
 * went, and a person has to be told so and allowed to settle it.
 */

export const SEND_TIMEOUT_MS = 2 * 60_000;

export function sendOutcomeUnknown(
  reply: { status: string; sending_started_at: string | null; updated_at: string },
  now: Date = new Date(),
): boolean {
  if (reply.status !== "sending") {
    return false;
  }
  const started = Date.parse(reply.sending_started_at ?? reply.updated_at);
  if (!Number.isFinite(started)) {
    return true;
  }
  return now.getTime() - started > SEND_TIMEOUT_MS;
}

/**
 * What happens to a ticket's classification after an attempt.
 *
 * A failure worth retrying waits a little longer each time, so a rate limit
 * does not get hammered, and gives up after a handful of goes so one message
 * Claude will never manage cannot sit at the front of the queue forever. A
 * failure not worth retrying gives up straight away. Either way the ticket
 * stays in the inbox, marked as needing a person, with the reason.
 */

export const MAX_CLASSIFICATION_ATTEMPTS = 5;

export type ClassificationState = {
  classification_status: "pending" | "done" | "failed";
  classification_attempts: number;
  classification_error: string | null;
  classification_retry_at: string | null;
};

export function afterClassification(
  previousAttempts: number,
  outcome: { ok: true } | { ok: false; error: string; retryable: boolean },
  now: Date = new Date(),
): ClassificationState {
  const attempts = previousAttempts + 1;

  if (outcome.ok) {
    return {
      classification_status: "done",
      classification_attempts: attempts,
      classification_error: null,
      classification_retry_at: null,
    };
  }

  if (!outcome.retryable || attempts >= MAX_CLASSIFICATION_ATTEMPTS) {
    return {
      classification_status: "failed",
      classification_attempts: attempts,
      classification_error: outcome.error,
      classification_retry_at: null,
    };
  }

  // 2, 4, 8, 16 minutes.
  const waitMinutes = 2 ** attempts;
  return {
    classification_status: "pending",
    classification_attempts: attempts,
    classification_error: outcome.error,
    classification_retry_at: new Date(now.getTime() + waitMinutes * 60_000).toISOString(),
  };
}

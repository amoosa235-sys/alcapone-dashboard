import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import {
  DRAFTER_PROMPT_VERSION,
  DRAFTER_SYSTEM,
  DraftSchema,
  type Draft,
} from "./schema";

/**
 * Drafting, in one call per press of the button.
 *
 * Deliberately separate from sending, and from the classifier: drafting is
 * something an agent asks for, on a ticket they are looking at, and can throw
 * away. Nothing here writes to the database or talks to a channel.
 */

export const DRAFTER_MODEL = "claude-opus-5";

export type DraftInput = {
  workspaceName: string;
  channel: string;
  subject: string | null;
  body: string | null;
  customerName: string | null;
  orderNumber: string | null;
  category: string | null;
  summary: string | null;
  itemNeedingAttention: string | null;
  orderedItems: { name: string; quantity: number | null }[];
  /** Replies already sent on this ticket, oldest first. */
  alreadySent: string[];
};

export type DraftResult =
  | { ok: true; draft: Draft; model: string; promptVersion: string }
  | { ok: false; error: string; retryable: boolean };

function describe(input: DraftInput): string {
  const known = Object.entries({
    "Workspace replying": input.workspaceName,
    "Arrived on": input.channel,
    "Customer name": input.customerName,
    "Order number": input.orderNumber,
    "Sorted as": input.category,
    "One line summary": input.summary,
    "Item they are writing about": input.itemNeedingAttention,
    "Items on the order": input.orderedItems.length
      ? input.orderedItems
          .map((item) =>
            item.quantity && item.quantity > 1
              ? `${item.name} x${item.quantity}`
              : item.name,
          )
          .join(", ")
      : null,
  })
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");

  const history = input.alreadySent.length
    ? `\nAlready sent to this customer on this ticket, oldest first:\n${input.alreadySent
        .map((reply, index) => `--- reply ${index + 1} ---\n${reply}`)
        .join("\n")}\n`
    : "";

  return [
    `What is known:\n${known}`,
    history,
    `\nSubject: ${input.subject ?? "(none)"}`,
    `\nTheir message:\n${input.body ?? "(empty)"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function draftReply(
  input: DraftInput,
  apiKey?: string,
): Promise<DraftResult> {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      ok: false,
      error: "ANTHROPIC_API_KEY is not set on this deployment.",
      retryable: false,
    };
  }

  const client = new Anthropic({ apiKey: key });

  try {
    const response = await client.messages.parse({
      model: DRAFTER_MODEL,
      max_tokens: 2000,
      system: DRAFTER_SYSTEM,
      output_config: { format: zodOutputFormat(DraftSchema) },
      messages: [{ role: "user", content: describe(input) }],
    });

    if (response.stop_reason === "refusal") {
      return {
        ok: false,
        error: `Claude declined to draft this reply (${response.stop_details?.category ?? "no category"}).`,
        retryable: false,
      };
    }

    if (!response.parsed_output) {
      return {
        ok: false,
        error: `Claude's answer did not match the expected shape (stopped: ${response.stop_reason}).`,
        retryable: true,
      };
    }

    if (!response.parsed_output.body.trim()) {
      return { ok: false, error: "Claude came back with an empty reply.", retryable: true };
    }

    return {
      ok: true,
      draft: response.parsed_output,
      model: response.model,
      promptVersion: DRAFTER_PROMPT_VERSION,
    };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return { ok: false, error: "The Anthropic API key was rejected.", retryable: false };
    }
    if (error instanceof Anthropic.RateLimitError) {
      return { ok: false, error: "Rate limited by the Anthropic API. Try again shortly.", retryable: true };
    }
    if (error instanceof Anthropic.BadRequestError) {
      return { ok: false, error: `Anthropic rejected the request: ${error.message}`, retryable: false };
    }
    if (error instanceof Anthropic.APIError) {
      return {
        ok: false,
        error: `Anthropic API error ${error.status ?? ""}: ${error.message}`.trim(),
        retryable: (error.status ?? 500) >= 500,
      };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Drafting failed.",
      retryable: true,
    };
  }
}

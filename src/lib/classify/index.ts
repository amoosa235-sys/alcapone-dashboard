import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import {
  CLASSIFIER_PROMPT_VERSION,
  CLASSIFIER_SYSTEM,
  ClassificationSchema,
  type Classification,
} from "./schema";

/**
 * Classification and extraction, in one call per ticket.
 *
 * Structured outputs do the schema work: the response is validated against
 * ClassificationSchema before it is returned, so a malformed answer fails
 * here rather than halfway into an insert. Effort is low because sorting a
 * support message is not a reasoning problem, and this runs on every ticket.
 */

export const CLASSIFIER_MODEL = "claude-opus-5";

export type ClassifierInput = {
  subject: string | null;
  body: string | null;
  channel: string;
  /** What the channel already knows, which the model should not contradict. */
  known?: {
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    orderNumber?: string | null;
  };
};

export type ClassifyResult =
  | { ok: true; classification: Classification; model: string; promptVersion: string }
  | { ok: false; error: string; retryable: boolean };

function describe(input: ClassifierInput): string {
  const known = input.known ?? {};
  const facts = Object.entries({
    "Customer name on file": known.customerName,
    "Email on file": known.customerEmail,
    "Phone on file": known.customerPhone,
    "Order number on file": known.orderNumber,
  })
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");

  return [
    `Channel: ${input.channel}`,
    facts ? `\nAlready known from the channel:\n${facts}` : "",
    `\nSubject: ${input.subject ?? "(none)"}`,
    `\nMessage:\n${input.body ?? "(empty)"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function classifyTicket(
  input: ClassifierInput,
  apiKey?: string,
): Promise<ClassifyResult> {
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
      model: CLASSIFIER_MODEL,
      max_tokens: 2000,
      system: CLASSIFIER_SYSTEM,
      output_config: {
        effort: "low",
        format: zodOutputFormat(ClassificationSchema),
      },
      messages: [{ role: "user", content: describe(input) }],
    });

    if (response.stop_reason === "refusal") {
      return {
        ok: false,
        error: `Claude declined to classify this message (${response.stop_details?.category ?? "no category"}).`,
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

    return {
      ok: true,
      classification: response.parsed_output,
      model: response.model,
      promptVersion: CLASSIFIER_PROMPT_VERSION,
    };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return { ok: false, error: "The Anthropic API key was rejected.", retryable: false };
    }
    if (error instanceof Anthropic.RateLimitError) {
      return { ok: false, error: "Rate limited by the Anthropic API.", retryable: true };
    }
    if (error instanceof Anthropic.BadRequestError) {
      return { ok: false, error: `Anthropic rejected the request: ${error.message}`, retryable: false };
    }
    if (error instanceof Anthropic.APIError) {
      // 5xx and connection failures are worth another go; 4xx are not, and
      // were caught above.
      return {
        ok: false,
        error: `Anthropic API error ${error.status ?? ""}: ${error.message}`.trim(),
        retryable: (error.status ?? 500) >= 500,
      };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Classification failed.",
      retryable: true,
    };
  }
}

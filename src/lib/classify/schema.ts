import { z } from "zod";

import { TICKET_CATEGORIES } from "@/types/database";

/**
 * What Claude is asked to return for a ticket, and the shape the answer is
 * validated against before any of it reaches the database.
 *
 * The fields line up one for one with ticket_classifications, so a change
 * here is a migration there. Everything optional is nullable rather than
 * absent: a structured output has to have every key, and "not in the message"
 * is a real answer worth storing.
 */
export const ClassificationSchema = z.object({
  category: z.enum(TICKET_CATEGORIES),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How sure you are of the category, 0 to 1."),
  summary: z.string().describe("One sentence an agent could read at a glance."),
  customer_name: z.string().nullable(),
  contact_number: z.string().nullable(),
  order_number: z
    .string()
    .nullable()
    .describe("Exactly as written, including any # prefix."),
  ordered_items: z
    .array(
      z.object({
        name: z.string(),
        sku: z.string().nullable(),
        quantity: z.number().nullable(),
      }),
    )
    .describe("Every item mentioned as part of the order."),
  item_needing_attention: z
    .string()
    .nullable()
    .describe("The one item the customer is writing about, if it is one item."),
});

export type Classification = z.infer<typeof ClassificationSchema>;

export const CLASSIFIER_PROMPT_VERSION = "2026-09-22.1";

export const CLASSIFIER_SYSTEM = `You sort incoming customer support messages for a retailer.

Pick one category:
- enquiry: a question. Where is my order, do you have this in another size, when do you restock.
- return: the customer wants to send something back for a refund.
- exchange: the customer wants to swap something for a different size, colour or item.
- general_complaint: dissatisfaction that is not a return or an exchange. Damage, lateness, rudeness, a wrong item, a billing problem.

Then pull out what an agent would otherwise have to read the message to find.

Rules:
- Use only what is in the message. Never invent an order number, a name or a phone number, and never repair a partial one.
- Copy the order number exactly as written, including a # if it is there.
- item_needing_attention is the single item being complained about, returned or exchanged. Leave it null when the message is about the whole order or names no item.
- ordered_items is every item the message mentions as part of the order. An empty list is correct when none are named.
- A customer can be unhappy and still be asking a question. If the thing they want is an answer, it is an enquiry.
- Set confidence below 0.5 when the message is too short or too vague to be sure.`;

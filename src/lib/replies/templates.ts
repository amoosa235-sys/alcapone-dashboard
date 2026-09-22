/**
 * Saved replies: the answers a team gives every day, written once.
 *
 * A saved reply can name the customer, the order and the item with
 * placeholders in curly brackets, filled from the ticket when it is dropped
 * into the reply box. A placeholder the ticket cannot fill is left visible,
 * in brackets, so the agent sees the gap before sending instead of the
 * customer seeing a blank.
 */

export const TEMPLATE_PLACEHOLDERS = [
  { key: "first_name", label: "Customer's first name" },
  { key: "name", label: "Customer's full name" },
  { key: "order", label: "Order number" },
  { key: "item", label: "Item they wrote about" },
  { key: "workspace", label: "Your workspace name" },
] as const;

export type TemplateValues = {
  name: string | null;
  order: string | null;
  item: string | null;
  workspace: string | null;
};

export function fillTemplate(body: string, values: TemplateValues): string {
  const firstName = values.name?.trim().split(/\s+/)[0] ?? null;
  const lookup: Record<string, string | null> = {
    first_name: firstName || null,
    name: values.name?.trim() || null,
    order: values.order?.trim() || null,
    item: values.item?.trim() || null,
    workspace: values.workspace?.trim() || null,
  };

  return body.replace(/\{\s*([a-z_]+)\s*\}/gi, (match, key: string) => {
    const name = key.toLowerCase();
    if (!(name in lookup)) {
      return match;
    }
    return lookup[name] ?? `[${name.replace(/_/g, " ")}]`;
  });
}

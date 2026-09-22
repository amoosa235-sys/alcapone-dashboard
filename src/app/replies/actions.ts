"use server";

import { revalidatePath } from "next/cache";

import { getMembership, getUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * Saved replies are the workspace's own words, so any member can add or
 * remove one. Row level security keeps each workspace to its own.
 */

export type SavedReplyState = { error: string | null; notice: string | null };

async function member() {
  const user = await getUser();
  const membership = user ? await getMembership() : null;
  return user && membership ? { userId: user.id, tenantId: membership.tenantId } : null;
}

export async function createSavedReply(
  _previous: SavedReplyState,
  formData: FormData,
): Promise<SavedReplyState> {
  const who = await member();
  if (!who) {
    return { error: "Sign in again, your session has expired.", notice: null };
  }

  const title = String(formData.get("title") ?? "").trim().slice(0, 120);
  const body = String(formData.get("body") ?? "").trim().slice(0, 5000);
  if (!title || !body) {
    return { error: "A saved reply needs a name and some words.", notice: null };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("saved_replies")
    .insert({ tenant_id: who.tenantId, title, body, created_by: who.userId });

  if (error) {
    console.error("saved replies: could not save", { code: error.code, message: error.message });
    return { error: "Could not save that. Try again.", notice: null };
  }

  revalidatePath("/replies");
  return { error: null, notice: `Saved “${title}”.` };
}

export async function deleteSavedReply(formData: FormData): Promise<void> {
  const who = await member();
  const id = formData.get("id");
  if (!who || typeof id !== "string") {
    return;
  }

  const supabase = await createClient();
  await supabase.from("saved_replies").delete().eq("id", id);
  revalidatePath("/replies");
}

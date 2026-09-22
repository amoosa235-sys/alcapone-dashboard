"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type SetupFormState = { error: string | null };

/**
 * First-run setup: names the workspace and makes the caller its owner. The
 * database function refuses once any tenant exists, so this cannot be replayed.
 */
export async function claimWorkspace(
  _prev: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  const user = await getUser();
  if (!user) {
    redirect("/login");
  }

  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { error: "Give the workspace a name." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("claim_initial_tenant", {
    tenant_name: name,
  });

  if (error) {
    return {
      error:
        error.code === "42501"
          ? "This install has already been set up. Ask its owner to add you."
          : error.message,
    };
  }

  revalidatePath("/", "layout");
  redirect("/");
}

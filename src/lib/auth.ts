import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Enums } from "@/types/database";

export type Membership = {
  tenantId: string;
  tenantName: string;
  role: Enums<"tenant_role">;
};

export type Viewer = {
  user: User;
  membership: Membership;
};

/**
 * The signed-in user, verified against Supabase rather than read from the
 * cookie. Returns null when nobody is signed in.
 */
export async function getUser(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * The tenant the signed-in user belongs to, or null if they belong to none.
 * RLS already limits this query to their own membership rows, so no filter by
 * user id is needed here.
 */
export async function getMembership(): Promise<Membership | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("tenant_members")
    .select("tenant_id, role, tenants(name)")
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return {
    tenantId: data.tenant_id,
    tenantName: data.tenants?.name ?? "Your workspace",
    role: data.role,
  };
}

/**
 * Guards every page that reads tenant data. Sends a signed-out user to login,
 * a user with no tenant to setup or to the holding page, and otherwise hands
 * back who they are and which tenant they are in.
 */
export async function requireMembership(): Promise<Viewer> {
  const user = await getUser();
  if (!user) {
    redirect("/login");
  }

  const membership = await getMembership();
  if (!membership) {
    redirect((await hasAnyTenant()) ? "/pending" : "/setup");
  }

  return { user, membership };
}

/**
 * Whether the install has been set up yet. This runs with the service role
 * because a user who is not a member of anything cannot see tenants at all
 * under RLS, which is exactly the case being tested.
 */
export async function hasAnyTenant(): Promise<boolean> {
  const { count, error } = await createAdminClient()
    .from("tenants")
    .select("id", { head: true, count: "exact" });

  if (error) {
    // Fail closed: treat an unreadable database as "already set up" so a
    // transient error cannot expose the first-run setup page.
    return true;
  }

  return (count ?? 0) > 0;
}

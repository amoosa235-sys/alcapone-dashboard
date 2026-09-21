import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { publicEnv, serverEnv } from "@/lib/env";
import type { Database } from "@/types/database";

/**
 * Service-role client. This bypasses RLS, so it is only for trusted
 * server-side work: webhook ingestion, mailbox polling, classification writes
 * and anything that touches channel_secrets. Always filter by tenant_id
 * explicitly here, since the database will not do it for you.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    publicEnv.supabaseUrl,
    serverEnv.supabaseServiceRoleKey,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

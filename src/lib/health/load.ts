import { SEND_TIMEOUT_MS } from "@/lib/replies/outcome";
import { createClient } from "@/lib/supabase/server";

import { workspaceWarnings, type HealthWarning } from "./workspace";

/**
 * Reads what the workspace health check needs, under the member's own
 * session, so it only ever sees their workspace.
 */
export async function loadWorkspaceHealth(): Promise<{
  warnings: HealthWarning[];
  lastJobRunAt: string | null;
}> {
  const supabase = await createClient();
  const cutoff = new Date(Date.now() - SEND_TIMEOUT_MS).toISOString();

  const [channels, heartbeat, failed, stuck] = await Promise.all([
    supabase
      .from("channels")
      .select("type, status, display_name, last_error, last_synced_at, config"),
    supabase
      .from("job_heartbeats")
      .select("last_run_at")
      .order("last_run_at", { ascending: false })
      .limit(1),
    supabase
      .from("tickets")
      .select("id", { head: true, count: "exact" })
      .eq("classification_status", "failed")
      .neq("status", "closed")
      .is("merged_into_ticket_id", null),
    supabase
      .from("ticket_replies")
      .select("id", { head: true, count: "exact" })
      .eq("status", "sending")
      .lt("sending_started_at", cutoff),
  ]);

  const lastJobRunAt = heartbeat.data?.[0]?.last_run_at ?? null;
  return {
    lastJobRunAt,
    warnings: workspaceWarnings({
      channels: channels.data ?? [],
      lastJobRunAt,
      failedClassifications: failed.count ?? 0,
      stuckSends: stuck.count ?? 0,
    }),
  };
}

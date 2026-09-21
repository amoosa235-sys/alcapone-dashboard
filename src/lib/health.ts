import { createClient } from "@/lib/supabase/server";

export type HealthReport = {
  ok: boolean;
  checkedAt: string;
  env: Record<string, boolean>;
  supabase: { reachable: boolean; error: string | null };
};

const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
] as const;

/**
 * Proves the deployed app can reach Supabase. The count comes back as zero for
 * a signed-out caller because RLS denies every row by default, so what this
 * asserts is a live round trip, not the presence of data.
 */
export async function checkHealth(): Promise<HealthReport> {
  const env = Object.fromEntries(
    REQUIRED_ENV.map((name) => [name, Boolean(process.env[name])]),
  );

  let reachable = false;
  let error: string | null = null;

  try {
    const supabase = await createClient();
    const result = await supabase
      .from("tenants")
      .select("id", { head: true, count: "exact" });

    if (result.error) {
      // A network failure comes back with an empty message, so fall back to
      // whatever else the error carries rather than reporting nothing.
      error =
        result.error.message ||
        result.error.details ||
        result.error.code ||
        "request to Supabase failed";
    } else {
      reachable = true;
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  return {
    ok: reachable && Object.values(env).every(Boolean),
    checkedAt: new Date().toISOString(),
    env,
    supabase: { reachable, error },
  };
}

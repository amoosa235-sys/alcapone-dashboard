import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { runTenantJobs, summarise } from "@/lib/pipeline/jobs";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The recurring job: read the mailboxes, catch up on Shopify, then classify
 * anything still waiting, for every workspace.
 *
 * The database's scheduler calls this every five minutes (see the
 * job_schedule migration) with a token it keeps in Vault. Vercel Cron, if a
 * CRON_SECRET is set, and anyone holding JOBS_SECRET can call it too.
 * Tokens are only accepted in the Authorization header: a token in a query
 * string ends up in logs and browser history.
 *
 * Every workspace gets a share of the time limit, so one busy workspace
 * cannot use all of it.
 */

export const maxDuration = 300;

/** Stop starting new work this long before the platform's limit. */
const SAFETY_MS = 30_000;

let cachedRunnerToken: { value: string | null; fetchedAt: number } | null = null;

async function runnerToken(): Promise<string | null> {
  if (cachedRunnerToken && Date.now() - cachedRunnerToken.fetchedAt < 300_000) {
    return cachedRunnerToken.value;
  }
  const { data, error } = await createAdminClient().rpc("jobs_runner_token");
  const value = !error && typeof data === "string" && data ? data : null;
  cachedRunnerToken = { value, fetchedAt: Date.now() };
  return value;
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function authorised(request: NextRequest): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return false;
  }
  const presented = header.slice("Bearer ".length).trim();
  if (!presented) {
    return false;
  }

  for (const secret of [process.env.JOBS_SECRET, process.env.CRON_SECRET]) {
    if (secret && same(presented, secret)) {
      return true;
    }
  }

  const fromDatabase = await runnerToken();
  return Boolean(fromDatabase && same(presented, fromDatabase));
}

export async function GET(request: NextRequest) {
  if (!(await authorised(request))) {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }

  const started = Date.now();
  const hardDeadline = started + maxDuration * 1000 - SAFETY_MS;
  const admin = createAdminClient();

  const { data: tenants, error } = await admin.from("tenants").select("id, name");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const list = tenants ?? [];
  const report = [];
  for (const [index, tenant] of list.entries()) {
    // An even share of whatever time is left.
    const remaining = hardDeadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    const deadline = Date.now() + remaining / (list.length - index);
    const outcome = await runTenantJobs(admin, tenant.id, {
      origin: request.nextUrl.origin,
      deadline,
    });
    report.push({ tenant: tenant.name, ...summarise(outcome) });
  }

  return NextResponse.json({ ranAt: new Date().toISOString(), report });
}

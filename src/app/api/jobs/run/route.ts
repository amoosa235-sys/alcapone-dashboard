import { NextResponse, type NextRequest } from "next/server";

import { classifyOutstanding, syncAllMailboxes } from "@/lib/pipeline/jobs";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The recurring job: check the mailboxes, then classify anything still
 * waiting. Vercel Cron calls this on a schedule; it is also safe to call by
 * hand, and the channels page has a button that does.
 *
 * Authorisation is a shared secret, because there is no session here. Vercel
 * Cron sends it as a bearer token; the query form exists so the job can be
 * kicked from a browser or a curl without one.
 */

export const maxDuration = 300;

function authorised(request: NextRequest): boolean {
  const secret = process.env.JOBS_SECRET;
  if (!secret) {
    return false;
  }

  const header = request.headers.get("authorization");
  if (header === `Bearer ${secret}`) {
    return true;
  }

  return request.nextUrl.searchParams.get("key") === secret;
}

export async function GET(request: NextRequest) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: tenants, error } = await admin.from("tenants").select("id, name");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const report = [];
  for (const tenant of tenants ?? []) {
    const mailboxes = await syncAllMailboxes(admin, tenant.id);
    const classified = await classifyOutstanding(admin, tenant.id);
    report.push({
      tenant: tenant.name,
      mailboxes,
      classified: classified.map((entry) => ({
        ticketId: entry.ticketId,
        category: entry.category,
        error: entry.classificationError,
        duplicatesLinked: entry.duplicatesLinked,
        duplicateReasons: entry.duplicateReasons,
      })),
    });
  }

  return NextResponse.json({ ranAt: new Date().toISOString(), report });
}

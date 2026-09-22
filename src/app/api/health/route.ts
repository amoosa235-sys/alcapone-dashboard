import { NextResponse } from "next/server";

import { checkHealth } from "@/lib/health/deploy";

export const dynamic = "force-dynamic";

export async function GET() {
  const report = await checkHealth();
  return NextResponse.json(report, { status: report.ok ? 200 : 503 });
}

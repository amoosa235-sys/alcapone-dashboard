import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

/**
 * Lands the link from a confirmation or recovery email and turns it into a
 * session cookie.
 *
 * This expects the token_hash form of the link. Supabase's stock email
 * template instead sends the user through its own verify endpoint, which
 * returns the tokens in a URL fragment that server code cannot read, so the
 * template has to be pointed here for this route to be used. Until then,
 * confirmation is simply switched off for the project.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next");
  const destination = next?.startsWith("/") && !next.startsWith("//") ? next : "/";

  if (!tokenHash || !type) {
    return NextResponse.redirect(
      new URL("/login?error=invalid-link", request.url),
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({
    type,
    token_hash: tokenHash,
  });

  if (error) {
    return NextResponse.redirect(
      new URL("/login?error=expired-link", request.url),
    );
  }

  return NextResponse.redirect(new URL(destination, request.url));
}

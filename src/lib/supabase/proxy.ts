import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { publicEnv } from "@/lib/env";
import type { Database } from "@/types/database";

/**
 * Refreshes the Supabase session on every request and reports who is signed
 * in. Access tokens are short-lived, so without this a user is silently
 * logged out as soon as theirs expires.
 *
 * The response carries any rotated cookies, so callers must return the
 * response this hands back rather than building a fresh one.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    publicEnv.supabaseUrl,
    publicEnv.supabasePublishableKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser revalidates the token with Supabase. getSession only decodes the
  // cookie, which the client could have forged, so it is never the check.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { response, user };
}

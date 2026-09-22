import type { GraphMessage } from "./tickets";

/**
 * The slice of Microsoft Graph this app uses.
 *
 * Authentication is the client credentials flow: the app registration holds
 * Mail.Read as an application permission, so there is no user to send through
 * a consent screen and no refresh token to keep alive. That matches what the
 * channels form already collects -- tenant id, client id, client secret and
 * the mailbox to read.
 */

export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
export const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

export type OutlookCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

export async function fetchGraphToken(
  credentials: OutlookCredentials,
): Promise<string> {
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        scope: GRAPH_SCOPE,
        grant_type: "client_credentials",
      }),
    },
  );

  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
    error?: string;
  };

  if (!response.ok || !body.access_token) {
    throw new Error(
      body.error_description ??
        body.error ??
        `Microsoft refused the token request (${response.status}).`,
    );
  }

  return body.access_token;
}

/**
 * Messages that arrived since the last sync, oldest first so that a failure
 * part way through leaves a cursor that can be resumed from.
 */
export async function fetchMessagesSince(
  token: string,
  mailbox: string,
  since: string | null,
  limit = 25,
): Promise<GraphMessage[]> {
  const url = new URL(
    `${GRAPH_ROOT}/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages`,
  );
  url.searchParams.set(
    "$select",
    "id,conversationId,subject,bodyPreview,body,from,sender,receivedDateTime,createdDateTime",
  );
  url.searchParams.set("$orderby", "receivedDateTime asc");
  url.searchParams.set("$top", String(limit));
  if (since) {
    url.searchParams.set("$filter", `receivedDateTime gt ${since}`);
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Graph would not list messages (${response.status}): ${detail.slice(0, 200)}`,
    );
  }

  const body = (await response.json()) as { value?: GraphMessage[] };
  return body.value ?? [];
}

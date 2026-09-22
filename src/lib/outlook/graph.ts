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
 * Graph ids change when a message moves between folders unless immutable ids
 * are asked for, and a ticket keeps the id of the message it will reply to,
 * so every call asks for them.
 */
export const IMMUTABLE_IDS = { Prefer: 'IdType="ImmutableId"' };

const MESSAGE_FIELDS = [
  "id",
  "conversationId",
  "subject",
  "bodyPreview",
  "body",
  "from",
  "sender",
  "replyTo",
  "internetMessageHeaders",
  "receivedDateTime",
  "createdDateTime",
].join(",");

export type MessagePage = {
  messages: GraphMessage[];
  /** Where the next page is, or null when this was the last one. */
  nextLink: string | null;
};

/**
 * One page of the inbox, oldest first, from `since` onwards.
 *
 * The filter is "received at or after", not "after": Graph timestamps only go
 * down to the second, so "after the newest one I took" would skip a message
 * that arrived in the same second as it. Taking that second again is safe,
 * because ingestion recognises a message it already has.
 */
export async function fetchMessagePage(
  token: string,
  mailbox: string,
  since: string | null,
  nextLink: string | null,
  pageSize = 50,
): Promise<MessagePage> {
  let url: URL;
  if (nextLink) {
    url = new URL(nextLink);
    // A next link from anywhere but Graph is not one to follow with a token.
    if (url.origin !== new URL(GRAPH_ROOT).origin) {
      throw new Error("Graph returned a next page link to somewhere else.");
    }
  } else {
    url = new URL(
      `${GRAPH_ROOT}/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages`,
    );
    url.searchParams.set("$select", MESSAGE_FIELDS);
    url.searchParams.set("$orderby", "receivedDateTime asc");
    url.searchParams.set("$top", String(pageSize));
    if (since) {
      url.searchParams.set("$filter", `receivedDateTime ge ${since}`);
    }
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ...IMMUTABLE_IDS },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Graph would not list messages (${response.status}): ${detail.slice(0, 200)}`,
    );
  }

  const body = (await response.json()) as {
    value?: GraphMessage[];
    "@odata.nextLink"?: string;
  };
  return { messages: body.value ?? [], nextLink: body["@odata.nextLink"] ?? null };
}

export type SentMessage = { id: string; sentDateTime: string | null };

/**
 * Replies this mailbox sent on one conversation, for settling whether a send
 * that was cut off actually went. Reading Sent Items needs only Mail.Read,
 * which the app already has.
 */
export async function fetchSentOnConversation(
  token: string,
  mailbox: string,
  conversationId: string,
): Promise<SentMessage[]> {
  const url = new URL(
    `${GRAPH_ROOT}/users/${encodeURIComponent(mailbox)}/mailFolders/sentitems/messages`,
  );
  url.searchParams.set("$select", "id,sentDateTime,conversationId");
  url.searchParams.set(
    "$filter",
    `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
  );
  url.searchParams.set("$top", "50");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ...IMMUTABLE_IDS },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Graph would not list sent mail (${response.status}): ${detail.slice(0, 200)}`,
    );
  }

  const body = (await response.json()) as { value?: SentMessage[] };
  return body.value ?? [];
}

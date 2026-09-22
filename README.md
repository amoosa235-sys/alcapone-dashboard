# Support dashboard

A unified support inbox. It pulls customer messages from Shopify stores,
Microsoft 365 mailboxes and WhatsApp into one ticket queue, classifies each
one with Claude, flags the same issue arriving on two channels as a duplicate,
and lets an agent reply from a single place.

Next.js (App Router) on Vercel, Supabase Postgres for data and auth, Claude for
classification and reply drafting.

## Status

Steps 1 to 5 and 7: you can sign in, connect Shopify stores and Microsoft 365
mailboxes, and what arrives is classified by Claude and matched against the
same issue on another channel. The dashboard UI (step 6) and WhatsApp (step 8)
are still to come.

Production deploys from `main` on every push, at
https://alcapone-dashboard.vercel.app.

| Step | What |
| --- | --- |
| 1 | Scaffold, repo, Vercel, core tables |
| 2 | Supabase Auth with tenant-scoped RLS |
| 3 | Shopify OAuth and webhooks |
| 4 | Microsoft Graph OAuth and mailbox sync |
| 5 | Claude classification and extraction |
| 6 | Dashboard UI |
| 7 | Duplicate detection |
| 8 | WhatsApp Business API |

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in the four values
npm run dev
```

`/status` renders a pipeline check and `/api/health` returns the same report as
JSON. Both report `ok` only when every environment variable is set and a
Supabase round trip succeeds. Neither needs a session.

## Signing in

Email and password, through Supabase Auth.

| Route | What it is for |
| --- | --- |
| `/login` | Sign in or create an account |
| `/setup` | First run: name the workspace and become its owner |
| `/pending` | Signed in, but not a member of any workspace yet |
| `/` | The dashboard, for a signed-in member |
| `/channels` | Add an account, see what is connected, run the job now |
| `/auth/confirm` | Lands a confirmation or recovery email link |

`src/proxy.ts` refreshes the session cookie on every request and bounces
signed-out visitors to `/login`. It is a convenience, not the boundary: every
page that reads tenant data calls `requireMembership()` in `src/lib/auth.ts`,
which verifies the user against Supabase rather than trusting the cookie.

The first person to sign up calls `claim_initial_tenant`, which creates the
workspace and makes them its owner. It refuses once any tenant exists, so it
cannot be replayed to mint more. Anyone who signs up after that lands on
`/pending` until an owner adds them — v1 has no invite flow, so that is a row
in `tenant_members`.

### Two Supabase settings this expects

Both live in the Supabase dashboard and neither is in code:

- **Site URL** (Authentication → URL Configuration) must be the deployed
  origin, or email links point at `localhost`.
- **Confirm email** (Authentication → Sign In / Providers → Email) is on by
  default. `/auth/confirm` handles the token_hash form of the link, which
  means the email template has to be pointed at it; until then, either turn
  confirmation off or click through Supabase's own redirect.

## Channels

`/channels` has three menus: a Shopify account, an email account and a social
account. Every option under them opens a real form for that account's
credentials. They are plain `<details>` elements, so the menus open before the
page hydrates.

| Menu | Account | Asks for |
| --- | --- | --- |
| Shopify | Shopify store | Store address; the rest comes from OAuth |
| Email | Microsoft 365 (Outlook) | Mailbox, tenant id, client id, client secret |
| Social | WhatsApp Business | Phone number id, WABA id, access token, verify token |
| Social | Instagram | Account id, page id, access token |
| Social | Facebook | Page id, page access token |

Shopify is the only one with an integration behind it. The rest save their
credentials and sit at `pending`; their forms say so in as many words, and the
connected list shows them as "Saved, not connected yet". The fields come from
`CHANNEL_SPECS` in `src/lib/channels/specs.ts`, which also drives what the
server action validates and which values are treated as secret, so the form
and the check cannot drift apart.

Anything marked secret goes to `channel_secrets`: `access_token` to its own
column, the rest into `extra`. That table has RLS on with no policies and its
grants revoked, so only the service role reads it back. An account's
identifier is never a secret field, since it becomes `display_name`, which
everyone in the workspace can see; a test enforces that.

## Shopify

An owner or admin connects a store from `/channels`. That starts OAuth at
`/api/shopify/install`, which validates the myshopify.com domain, puts a
single-use nonce in an httpOnly cookie and hands off to Shopify. Shopify comes
back to `/api/shopify/callback`, which will not write anything until the
nonce, the shop and Shopify's own HMAC all check out. The access token goes
into `channel_secrets`, and the store is subscribed to its webhooks.

`/api/shopify/webhooks` is the only route that runs without a session, so the
`X-Shopify-Hmac-Sha256` signature is verified against the raw body before the
payload is parsed. Topics:

| Topic | What happens |
| --- | --- |
| `orders/create` | A ticket, but only if the order carries a note |
| `orders/cancelled` | A ticket, with the reason and the items |
| `refunds/create` | A ticket; the order is fetched for the customer details |
| `app/uninstalled` | The channel is disabled and its token deleted |
| `shop/redact` | The channel and its tickets are deleted |
| `customers/redact` | That customer's details are cleared from their tickets |
| `customers/data_request` | Acknowledged; fulfilling it is a manual job |

Shopify has no customer inbox to read, so what arrives here is order activity
rather than conversations. Its value to the inbox is the order number and the
customer's email and phone on every ticket, which is what step 7 matches an
email or a WhatsApp message against. Shopify retries anything that is not a
2xx, so ingestion is idempotent on `(tenant_id, channel_id, external_id)`.

## Outlook

A mailbox is read with app-only access, so there is no user to send through a
consent screen: the app registration holds Mail.Read as an application
permission, and the four values the channels form collects -- mailbox, tenant
id, client id, client secret -- are exactly what the client credentials flow
needs.

`syncMailbox` asks Graph for messages newer than the channel's
`last_synced_at`, turns each into a ticket and moves the cursor only once they
are in. A failure leaves the cursor where it was, so the next run sees the
same messages again; the unique index on
`(tenant_id, channel_id, external_id)` is what keeps that from duplicating
them.

## Classification

Every new ticket is classified by Claude: one of the four categories, plus the
customer name, contact number, order number, the items on the order and the
one item needing attention. It is a single call per ticket using structured
outputs, so the answer is validated against the schema before any of it is
written.

Extraction only fills gaps. What a channel knew first-hand -- the email
address on a Shopify order, the sender of a message -- is never overwritten by
something read out of message text.

Classifications are kept as history. The live one for a ticket is the row with
`superseded_at is null`.

## Duplicates

The point of the product: one customer, one problem, two channels. Matching
runs after classification, because an email has no order number until
classification finds one in the text.

| Signal | Weight |
| --- | --- |
| Same order number | 0.6 |
| Same email address | 0.25 |
| Same phone number, last nine digits | 0.2 |
| Same category | 0.15 |
| Arrived on two different channels | 0.1 |

A pair needs 0.6 to be suggested, and at least one identifying signal -- order,
email or phone -- so category alone never links anything. Two messages in one
email thread, or two events on one Shopify order, are a conversation rather
than a duplicate and are skipped. Matches older than fourteen days apart are
not the same incident.

## Jobs

`/api/jobs/run` checks every mailbox and then classifies anything still
waiting. Vercel Cron calls it hourly with `JOBS_SECRET` as a bearer token; the
same secret works as a `?key=` for kicking it by hand, and the channels page
has a button for owners and admins. Everything it does is safe to run twice.

Classification also runs straight after a webhook, inside `after()`, so the
response goes back to Shopify well inside its five second limit.

## Data model

Seven tables, all under row level security.

- `tenants` — one paying company. v1 runs a single tenant, but every row in
  every other table carries `tenant_id` so v2 billing needs no migration.
- `tenant_members` — which `auth.users` row belongs to which tenant, and as
  `owner`, `admin` or `agent`. Every policy resolves against this table.
- `channels` — one connected source: a Shopify store, an Outlook mailbox or a
  WhatsApp number. Shopify and Outlook are unlimited per tenant; a partial
  unique index caps WhatsApp at one.
- `channel_secrets` — OAuth tokens and webhook signing secrets, split off so no
  agent-facing policy can reach them. RLS is on with no policies at all and the
  table grants are revoked, so only the service role can read it.
- `tickets` — every inbound message, normalized across channels, with the
  provider payload kept in `raw` for replay.
- `ticket_classifications` — Claude's verdict: category, the extracted customer
  and order details, and which item needs attention. Rows are kept as history;
  the live one for a ticket is the row where `superseded_at is null`.
- `duplicate_links` — a suggested, confirmed or rejected pair of tickets that
  are the same issue. A unique index on the ordered pair stores each pair once
  regardless of which ticket arrived first.

### Isolation

An authenticated user reaches only the rows whose `tenant_id` is one they are a
member of. The lookup lives in `private.current_tenant_ids()`, a security
definer function in a schema PostgREST does not expose, which is what keeps the
policy on `tenant_members` from recursing into itself.

Reads cover the whole tenant. Writes are deliberately narrow: agents update
tickets and resolve duplicate suggestions, owners and admins manage channels
and the member roster, and everything else — webhook ingestion, mailbox sync,
classification — is written by the service role from server-side routes, which
bypasses RLS. Code on that path must filter by `tenant_id` itself.

## Migrations

`supabase/migrations` holds the schema in order. They have been applied to the
Supabase project already; apply them to a new one with `supabase db push`.

Regenerate `src/types/database.ts` after any schema change:

```bash
SUPABASE_PROJECT_REF=<project-ref> npm run db:types
```

## Environment

| Variable | Where | Why |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | browser + server | anon-level key; RLS does the protecting |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | bypasses RLS, for ingestion and secrets |
| `ANTHROPIC_API_KEY` | server only | classification, extraction, reply drafting |
| `SHOPIFY_API_KEY` | server only | Shopify Partner app client id |
| `SHOPIFY_API_SECRET` | server only | signs and verifies everything Shopify sends |
| `SHOPIFY_APP_URL` | server only | optional; the origin Shopify redirects back to, if the forwarded host is wrong |
| `JOBS_SECRET` | server only | authorises `/api/jobs/run` for Vercel Cron |

The first four must be set in Vercel for every environment; `src/lib/env.ts`
is the only place they are read. The Shopify ones are read lazily in
`src/lib/shopify/config.ts`, so the rest of the app works without them and
`/channels` says Shopify is not set up rather than failing.

## Tests

```bash
npm test
```

`node --test` over `src/**/*.test.ts`. It covers the two Shopify signature
checks and the webhook-to-ticket normalisation, none of which touch the
network — a mistake in either is otherwise invisible until a real install
quietly fails.

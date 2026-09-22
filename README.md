# Support dashboard

A unified support inbox. It pulls customer messages from Shopify stores,
Microsoft 365 mailboxes and WhatsApp into one ticket queue, classifies each
one with Claude, flags the same issue arriving on two channels as a duplicate,
and lets an agent reply from a single place.

Next.js (App Router) on Vercel, Supabase Postgres for data and auth, Claude for
classification and reply drafting.

## Status

Steps 1 to 7: you can sign in, connect Shopify stores and Microsoft 365
mailboxes, and what arrives is classified by Claude, matched against the same
issue on another channel, and answered from the inbox. WhatsApp (step 8) is
still to come.

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
| `orders/cancelled` | Order history, with the reason and the items |
| `refunds/create` | Order history; the order is fetched for the customer details |
| `app/uninstalled` | The channel is disabled and its token deleted |
| `shop/redact` | The channel, its tickets and its order history are deleted |
| `customers/redact` | That customer is erased across the workspace: tickets, messages, what Claude read out of them, replies and order history |
| `customers/data_request` | Acknowledged; fulfilling it is a manual job |

Shopify has no customer inbox to read, so what arrives here is order activity
rather than conversations. Its value to the inbox is the order number and the
customer's email and phone on every ticket, which is what step 7 matches an
email or a WhatsApp message against. Shopify retries anything that is not a
2xx, so ingestion is idempotent on `(tenant_id, channel_id, external_id)`.

Cancellations and refunds are the store's own staff acting, so they are not
tickets: they are kept in `order_events` and shown beside that customer's
tickets. Webhooks can be lost, so every six hours the scheduled job lists the
orders updated since its last pass, files anything missing under the same
external ids the webhooks use, and re-registers the webhooks.

## Outlook

A mailbox is read with app-only access, so there is no user to send through a
consent screen: the app registration holds Mail.Read as an application
permission, and the four values the channels form collects -- mailbox, tenant
id, client id, client secret -- are exactly what the client credentials flow
needs.

To send replies it also needs Mail.Send. Application permissions reach every
mailbox in the organisation, so limit the app to the support mailbox with an
application access policy in Exchange Online. The form takes the secret's
expiry date, and the dashboard warns a month before it runs out.

`syncMailbox` pages through Graph for messages received since the channel's
`last_synced_at`, a page at a time, and moves the cursor after each page is
in. A failure leaves the cursor where it was, so the next run sees the same
messages again; the unique index on `(tenant_id, channel_id, external_id)` is
what keeps that from duplicating them. The first check only looks back 24
hours before the mailbox was connected, rather than importing the whole inbox.
Message ids are Graph's immutable kind, so a message a mailbox rule moves can
still be replied to.

Out-of-office replies, bounces, newsletters and no-reply notifications are
recognised from their headers and skipped. A contact form that sends from a
no-reply address with the customer in Reply-To is kept, with the customer
taken from Reply-To.

## Tickets

A ticket is a conversation. A customer writing again on the same email thread
or Shopify order is added to the ticket they already have (`ticket_messages`),
and the ticket goes back to Pending. A thread closed more than 30 days ago
starts a new ticket instead.

| Pile | Means | Order |
| --- | --- | --- |
| Unopened | Nobody has picked it up | Longest waiting first |
| Pending | Being worked on, or the customer wrote back | Longest waiting first |
| Waiting on customer | Answered; comes back when they reply | Most recent first |
| Closed | Done | Most recently closed first |

Sending a reply moves a ticket to Waiting and opens the next one in the pile.
The queue is paged, searchable across every pile, and filters by kind,
channel and assignee. Tickets can be assigned, merged, closed in bulk, and
answered with saved replies that fill in the customer's name and order.

Replies are drafted by Claude and sent by a person, never the other way round.
The database enforces it: a member can only create drafts, and only the
server's send path can mark a reply sent. A send that is cut off part way is
shown on the ticket as unconfirmed, with a button that looks in the mailbox's
Sent Items to settle whether it went.


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

A failed classification is retried by the scheduled job with a growing wait
(2, 4, 8, 16 minutes) and gives up after five attempts, or at once when the
failure is not worth retrying. A ticket Claude gave up on says so and has a
button to try again.

An agent can correct what Claude read out of a ticket. The correction is kept
as a classification of its own (`source = 'agent'`), duplicate matching runs
again on the corrected values, and the home page shows, per prompt version,
how often the team had to correct Claude.

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
email or phone -- so category alone never links anything. Two different order
numbers are two different problems however much else matches. Two Shopify
stores never share an order, and with more than one store an order number
read out of an email only counts when the email or phone matches too.
Candidates are read by indexed match keys (`order_key`, `email_key`,
`phone_key`) rather than by scanning the last fortnight of tickets.

An agent can confirm a suggestion by merging the two tickets, or reject it so
it is not suggested again. Two messages in one
email thread, or two events on one Shopify order, are a conversation rather
than a duplicate and are skipped. Matches older than fourteen days apart are
not the same incident.

## Jobs

`/api/jobs/run` does the recurring work for every workspace: check each
mailbox, catch up on Shopify every six hours, then classify anything waiting
whose retry time has come. Each workspace gets an even share of the time
limit, and anything unfinished is picked up by the next run. Everything it
does is safe to run twice. Each run records a heartbeat, and the dashboard
warns when the heartbeat goes quiet.

It runs every five minutes from Supabase's own scheduler (`pg_cron` calling
the route with `pg_net`), because Vercel's Hobby plan only allows daily crons.
The bearer token it sends is generated inside the database and kept in
Vault, so nobody has to copy a secret anywhere; the route reads it back
through `jobs_runner_token()`, which only the service role can call.
`JOBS_SECRET` and Vercel's `CRON_SECRET` are also accepted, in the
`Authorization` header only. The channels page has a button to run it now.

Classification also runs straight after a webhook, inside `after()`, so the
response goes back to Shopify well inside its five second limit.

## Data model

Every table is under row level security.

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
- `tickets` — one conversation, normalized across channels, with its first
  message's provider payload kept in `raw` for replay, and generated match
  keys for duplicate detection.
- `ticket_messages` — every customer message on a ticket, keyed on the
  provider's message id.
- `ticket_replies` — drafts and sent replies. Members write drafts; only the
  server marks one sent.
- `saved_replies` — a workspace's reusable answers.
- `order_events` — Shopify cancellations and refunds.
- `job_heartbeats` — when the scheduled job last ran for each workspace.
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
| `JOBS_SECRET` | server only | optional; authorises calling `/api/jobs/run` by hand |

The first four must be set in Vercel for every environment; `src/lib/env.ts`
is the only place they are read. The Shopify ones are read lazily in
`src/lib/shopify/config.ts`, so the rest of the app works without them and
`/channels` says Shopify is not set up rather than failing.

## Tests

```bash
npm test
```

`node --test` over `src/**/*.test.ts`. It covers the Shopify signature checks
and normalisation, telling automatic mail from a person, the duplicate rules,
the ticket piles and queue order, classification retries, saved reply
placeholders, unconfirmed sends and the workspace health warnings. None of it
touches the network.

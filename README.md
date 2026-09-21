# Support dashboard

A unified support inbox. It pulls customer messages from Shopify stores,
Microsoft 365 mailboxes and WhatsApp into one ticket queue, classifies each
one with Claude, flags the same issue arriving on two channels as a duplicate,
and lets an agent reply from a single place.

Next.js (App Router) on Vercel, Supabase Postgres for data and auth, Claude for
classification and reply drafting.

## Status

Step 1 of 8: the project is scaffolded and the schema is live. Nothing beyond
the pipeline check is built yet.

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

`/` renders a pipeline check and `/api/health` returns the same report as JSON.
Both report `ok` only when every environment variable is set and a Supabase
round trip succeeds.

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

All four must be set in Vercel for every environment. `src/lib/env.ts` is the
only place they are read.

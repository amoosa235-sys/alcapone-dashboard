-- Core multi-tenant schema for the support dashboard.
-- Tables: tenants, tenant_members, channels, channel_secrets, tickets,
-- ticket_classifications, duplicate_links.
-- Every tenant-owned row carries tenant_id; RLS is enabled in a later migration.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.channel_type as enum ('shopify', 'outlook', 'whatsapp');

create type public.channel_status as enum ('pending', 'connected', 'error', 'disabled');

create type public.tenant_role as enum ('owner', 'admin', 'agent');

create type public.ticket_status as enum ('unopened', 'pending', 'closed');

create type public.ticket_category as enum ('enquiry', 'return', 'exchange', 'general_complaint');

create type public.duplicate_link_status as enum ('suggested', 'confirmed', 'rejected');

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger tenants_set_updated_at
  before update on public.tenants
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- tenant_members: which auth user belongs to which tenant. This is the table
-- every RLS policy resolves against.
-- ---------------------------------------------------------------------------

create table public.tenant_members (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.tenant_role not null default 'agent',
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index tenant_members_user_id_idx on public.tenant_members (user_id);

-- ---------------------------------------------------------------------------
-- channels: one connected source of tickets. v1 allows unlimited Shopify
-- stores and Outlook mailboxes but only one WhatsApp number per tenant.
-- ---------------------------------------------------------------------------

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  type public.channel_type not null,
  status public.channel_status not null default 'pending',
  display_name text not null,
  -- Shopify shop domain, Outlook mailbox address, or WhatsApp phone number id.
  external_account_id text,
  -- Non-secret per-channel settings (webhook ids, sync cursors, folder names).
  config jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, type, external_account_id)
);

create index channels_tenant_id_idx on public.channels (tenant_id);

create unique index channels_one_whatsapp_per_tenant_idx
  on public.channels (tenant_id)
  where type = 'whatsapp';

create trigger channels_set_updated_at
  before update on public.channels
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- channel_secrets: OAuth tokens and webhook signing secrets, split out so that
-- no agent-facing policy can ever select them. RLS is enabled with no policies
-- at all, which leaves the service role as the only reader.
-- ---------------------------------------------------------------------------

create table public.channel_secrets (
  channel_id uuid primary key references public.channels (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  access_token text,
  refresh_token text,
  webhook_secret text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger channel_secrets_set_updated_at
  before update on public.channel_secrets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- tickets: every inbound customer message, normalized across channels.
-- ---------------------------------------------------------------------------

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  channel_id uuid references public.channels (id) on delete set null,
  -- Message or conversation id at the source, used for idempotent ingestion.
  external_id text,
  -- Groups replies from the same conversation (email thread, chat thread).
  external_thread_id text,
  status public.ticket_status not null default 'unopened',
  subject text,
  body text,
  customer_name text,
  customer_email text,
  customer_phone text,
  order_number text,
  assigned_to uuid references auth.users (id) on delete set null,
  -- Set when this ticket has been merged into another as a duplicate.
  merged_into_ticket_id uuid references public.tickets (id) on delete set null,
  received_at timestamptz not null default now(),
  last_message_at timestamptz,
  closed_at timestamptz,
  -- Original provider payload, kept for replay and debugging.
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tickets_not_merged_into_self check (merged_into_ticket_id is distinct from id)
);

create unique index tickets_channel_external_id_idx
  on public.tickets (tenant_id, channel_id, external_id)
  where external_id is not null;

create index tickets_tenant_status_received_idx
  on public.tickets (tenant_id, status, received_at desc);

create index tickets_tenant_order_number_idx
  on public.tickets (tenant_id, order_number)
  where order_number is not null;

create index tickets_tenant_customer_email_idx
  on public.tickets (tenant_id, lower(customer_email))
  where customer_email is not null;

create index tickets_tenant_customer_phone_idx
  on public.tickets (tenant_id, customer_phone)
  where customer_phone is not null;

create index tickets_tenant_thread_idx
  on public.tickets (tenant_id, external_thread_id)
  where external_thread_id is not null;

create trigger tickets_set_updated_at
  before update on public.tickets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- ticket_classifications: what Claude decided about a ticket. Rows are kept as
-- history; the live one for a ticket is the row with superseded_at is null.
-- ---------------------------------------------------------------------------

create table public.ticket_classifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  category public.ticket_category not null,
  confidence numeric(4, 3),
  summary text,
  customer_name text,
  contact_number text,
  order_number text,
  -- Every item on the order, as [{"name": ..., "sku": ..., "quantity": ...}].
  ordered_items jsonb not null default '[]'::jsonb,
  -- The specific item the customer is complaining about or returning.
  item_needing_attention text,
  model text,
  prompt_version text,
  raw_response jsonb,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint ticket_classifications_confidence_range
    check (confidence is null or (confidence >= 0 and confidence <= 1))
);

create unique index ticket_classifications_one_current_idx
  on public.ticket_classifications (ticket_id)
  where superseded_at is null;

create index ticket_classifications_tenant_category_idx
  on public.ticket_classifications (tenant_id, category)
  where superseded_at is null;

-- ---------------------------------------------------------------------------
-- duplicate_links: the same issue arriving on more than one channel. The pair
-- is stored once regardless of which ticket arrived first.
-- ---------------------------------------------------------------------------

create table public.duplicate_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  primary_ticket_id uuid not null references public.tickets (id) on delete cascade,
  duplicate_ticket_id uuid not null references public.tickets (id) on delete cascade,
  status public.duplicate_link_status not null default 'suggested',
  score numeric(4, 3),
  -- How the match was made: order_number, customer_contact, ai_similarity.
  match_reason text,
  -- 'rule' for a deterministic match, 'ai' for a Claude-judged one.
  detected_by text,
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint duplicate_links_distinct_tickets
    check (primary_ticket_id <> duplicate_ticket_id),
  constraint duplicate_links_score_range
    check (score is null or (score >= 0 and score <= 1))
);

create unique index duplicate_links_unique_pair_idx
  on public.duplicate_links (
    tenant_id,
    least(primary_ticket_id, duplicate_ticket_id),
    greatest(primary_ticket_id, duplicate_ticket_id)
  );

create index duplicate_links_tenant_status_idx
  on public.duplicate_links (tenant_id, status);

create index duplicate_links_duplicate_ticket_idx
  on public.duplicate_links (duplicate_ticket_id);

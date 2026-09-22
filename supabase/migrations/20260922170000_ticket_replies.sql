-- ---------------------------------------------------------------------------
-- ticket_replies: what gets said back to the customer.
--
-- A draft and a sent reply are the same row at two points in its life, which
-- is what makes "nothing goes out without a person pressing send" checkable
-- after the fact: a sent row carries who sent it, when, and whether the words
-- were Claude's, a person's, or Claude's edited by a person.
-- ---------------------------------------------------------------------------

create type public.reply_status as enum ('draft', 'sent', 'failed');

-- Who wrote the first version. A draft Claude wrote and an agent then rewrote
-- is still 'ai_draft' with edited_by_agent set, because where the words came
-- from is the thing worth being able to audit.
create type public.reply_author as enum ('ai_draft', 'agent');

create table public.ticket_replies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  status public.reply_status not null default 'draft',
  author public.reply_author not null default 'agent',
  body text not null,
  -- Set the moment a person changes a single character of a Claude draft.
  edited_by_agent boolean not null default false,
  -- Which model and prompt produced the draft, null for one typed by hand.
  model text,
  prompt_version text,
  created_by uuid references auth.users (id) on delete set null,
  -- Only ever written by the send path, never by the composer.
  sent_by uuid references auth.users (id) on delete set null,
  sent_at timestamptz,
  -- The provider's id for the message that actually went out.
  external_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ticket_replies_body_not_blank check (length(btrim(body)) > 0),
  constraint ticket_replies_sent_has_sender
    check (status <> 'sent' or (sent_by is not null and sent_at is not null))
);

-- One draft in flight per ticket. Anything already sent or failed is history
-- and does not count, so a ticket can hold a long reply trail and still only
-- ever have one thing waiting to be sent.
create unique index ticket_replies_one_draft_idx
  on public.ticket_replies (ticket_id)
  where status = 'draft';

create index ticket_replies_ticket_idx
  on public.ticket_replies (tenant_id, ticket_id, created_at desc);

create trigger ticket_replies_set_updated_at
  before update on public.ticket_replies
  for each row execute function public.set_updated_at();

alter table public.ticket_replies enable row level security;

create policy ticket_replies_select_own_tenant
  on public.ticket_replies for select to authenticated
  using (tenant_id in (select private.current_tenant_ids()));

create policy ticket_replies_insert_own_tenant
  on public.ticket_replies for insert to authenticated
  with check (tenant_id in (select private.current_tenant_ids()));

-- A reply can be rewritten while it is a draft and never afterwards: `using`
-- tests the row as it stands, so draft -> sent is allowed and sent -> anything
-- is not. Nothing can be quietly reworded after the customer has read it.
create policy ticket_replies_update_draft
  on public.ticket_replies for update to authenticated
  using (
    tenant_id in (select private.current_tenant_ids())
    and status = 'draft'
  )
  with check (tenant_id in (select private.current_tenant_ids()));

-- Same reasoning for throwing one away.
create policy ticket_replies_delete_draft
  on public.ticket_replies for delete to authenticated
  using (
    tenant_id in (select private.current_tenant_ids())
    and status = 'draft'
  );

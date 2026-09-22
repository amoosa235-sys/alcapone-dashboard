-- Tickets become conversations, Shopify order activity stops being tickets,
-- agents can correct Claude, and the database stops trusting the browser
-- with columns it has no business writing.
--
-- Everything here is additive or tightens a permission the app never used,
-- so the previous build keeps working against it.

-- ---------------------------------------------------------------------------
-- ticket_messages: every inbound customer message, grouped under the ticket
-- for its conversation. A customer's reply to our reply lands here on the
-- ticket it belongs to rather than as a new ticket of its own.
--
-- tickets.subject and tickets.body stay as the opening message, so the queue
-- can show a preview without reading this table.
-- ---------------------------------------------------------------------------

create table public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  channel_id uuid references public.channels (id) on delete set null,
  -- The provider's id for this message, which is what makes ingestion
  -- idempotent now that one ticket holds several messages.
  external_id text,
  sender_name text,
  sender_email text,
  subject text,
  body text,
  received_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index ticket_messages_channel_external_id_idx
  on public.ticket_messages (tenant_id, channel_id, external_id);

create index ticket_messages_ticket_idx
  on public.ticket_messages (tenant_id, ticket_id, received_at);

create index ticket_messages_channel_idx
  on public.ticket_messages (channel_id);

alter table public.ticket_messages enable row level security;

create policy ticket_messages_select_own_tenant
  on public.ticket_messages for select to authenticated
  using (tenant_id in (select private.current_tenant_ids()));

-- Written only by ingestion, which runs as the service role.
revoke insert, update, delete on public.ticket_messages from anon, authenticated;

-- Every existing ticket was one message, so each gets that message back.
insert into public.ticket_messages (
  tenant_id, ticket_id, channel_id, external_id, sender_name, sender_email,
  subject, body, received_at, raw
)
select
  t.tenant_id, t.id, t.channel_id, t.external_id, t.customer_name,
  t.customer_email, t.subject, t.body, t.received_at, t.raw
from public.tickets t
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- tickets: what the queue sorts, filters and matches on.
-- ---------------------------------------------------------------------------

alter table public.tickets
  -- The live category, copied from the current classification so the queue
  -- can filter on it without a join.
  add column if not exists category public.ticket_category,
  -- Where classification stands. 'pending' is picked up by the job, 'done'
  -- is finished, 'failed' has given up and waits for a person.
  add column if not exists classification_status text not null default 'pending',
  add column if not exists classification_attempts integer not null default 0,
  add column if not exists classification_error text,
  add column if not exists classification_retry_at timestamptz,
  -- Normalised forms the duplicate matcher compares, kept in step with
  -- normalizeOrderNumber, normalizeEmail and normalizePhone in
  -- src/lib/duplicates/detect.ts.
  add column if not exists order_key text generated always as (
    case
      when length(
        regexp_replace(
          regexp_replace(
            lower(regexp_replace(order_number, '^\s+|\s+$', '', 'g')),
            '^#', ''
          ),
          '\s+', '', 'g'
        )
      ) >= 3
      then regexp_replace(
        regexp_replace(
          lower(regexp_replace(order_number, '^\s+|\s+$', '', 'g')),
          '^#', ''
        ),
        '\s+', '', 'g'
      )
    end
  ) stored,
  add column if not exists email_key text generated always as (
    nullif(lower(regexp_replace(customer_email, '^\s+|\s+$', '', 'g')), '')
  ) stored,
  add column if not exists phone_key text generated always as (
    case
      when length(regexp_replace(customer_phone, '\D', '', 'g')) >= 9
      then right(regexp_replace(customer_phone, '\D', '', 'g'), 9)
    end
  ) stored;

alter table public.tickets
  add constraint tickets_classification_status_check
  check (classification_status in ('pending', 'done', 'failed'));

update public.tickets set last_message_at = received_at where last_message_at is null;
alter table public.tickets alter column last_message_at set default now();
alter table public.tickets alter column last_message_at set not null;

update public.tickets t
set category = c.category,
    classification_status = 'done'
from public.ticket_classifications c
where c.ticket_id = t.id
  and c.superseded_at is null;

create index tickets_tenant_status_last_message_idx
  on public.tickets (tenant_id, status, last_message_at);

create index tickets_tenant_order_key_idx
  on public.tickets (tenant_id, order_key) where order_key is not null;

create index tickets_tenant_email_key_idx
  on public.tickets (tenant_id, email_key) where email_key is not null;

create index tickets_tenant_phone_key_idx
  on public.tickets (tenant_id, phone_key) where phone_key is not null;

create index tickets_classification_queue_idx
  on public.tickets (tenant_id, received_at)
  where classification_status = 'pending';

create index tickets_assigned_to_idx on public.tickets (assigned_to);
create index tickets_channel_id_idx on public.tickets (channel_id);
create index tickets_merged_into_idx on public.tickets (merged_into_ticket_id);

-- Agents move tickets between piles, assign them and merge them. They do not
-- rewrite what the customer said, who the customer is, or the provider's
-- payload: those are written by ingestion and by correct_classification.
revoke update on public.tickets from anon, authenticated;
grant update (status, closed_at, assigned_to, merged_into_ticket_id)
  on public.tickets to authenticated;

-- ---------------------------------------------------------------------------
-- order_events: Shopify cancellations and refunds. Store staff issue every
-- refund, so these are the business's own actions, not customers writing
-- in. They sit beside a customer's tickets as history rather than in the
-- queue as work.
-- ---------------------------------------------------------------------------

create table public.order_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  channel_id uuid references public.channels (id) on delete cascade,
  external_id text not null,
  kind text not null check (kind in ('cancelled', 'refunded')),
  order_number text,
  customer_name text,
  customer_email text,
  customer_phone text,
  summary text not null,
  occurred_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  order_key text generated always as (
    case
      when length(
        regexp_replace(
          regexp_replace(
            lower(regexp_replace(order_number, '^\s+|\s+$', '', 'g')),
            '^#', ''
          ),
          '\s+', '', 'g'
        )
      ) >= 3
      then regexp_replace(
        regexp_replace(
          lower(regexp_replace(order_number, '^\s+|\s+$', '', 'g')),
          '^#', ''
        ),
        '\s+', '', 'g'
      )
    end
  ) stored,
  email_key text generated always as (
    nullif(lower(regexp_replace(customer_email, '^\s+|\s+$', '', 'g')), '')
  ) stored
);

create unique index order_events_channel_external_id_idx
  on public.order_events (tenant_id, channel_id, external_id);

create index order_events_order_key_idx
  on public.order_events (tenant_id, order_key) where order_key is not null;

create index order_events_email_key_idx
  on public.order_events (tenant_id, email_key) where email_key is not null;

create index order_events_channel_idx on public.order_events (channel_id);

alter table public.order_events enable row level security;

create policy order_events_select_own_tenant
  on public.order_events for select to authenticated
  using (tenant_id in (select private.current_tenant_ids()));

revoke insert, update, delete on public.order_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- ticket_classifications: an agent's correction is a classification too,
-- kept in the same history so disagreement with Claude can be counted.
-- ---------------------------------------------------------------------------

alter table public.ticket_classifications
  add column if not exists source text not null default 'claude',
  add column if not exists created_by uuid references auth.users (id) on delete set null;

alter table public.ticket_classifications
  add constraint ticket_classifications_source_check
  check (source in ('claude', 'agent'));

create index ticket_classifications_created_by_idx
  on public.ticket_classifications (created_by);

-- ---------------------------------------------------------------------------
-- ticket_replies: nobody but the server's send path can call a reply sent.
--
-- Before this, a member could insert a row already marked 'sent' naming any
-- sender, which made the audit trail something a browser could write.
-- ---------------------------------------------------------------------------

alter table public.ticket_replies
  -- Set when the send path claims a draft, so a claim that never finished
  -- can be told apart from one still in flight.
  add column if not exists sending_started_at timestamptz,
  add column if not exists claimed_by uuid references auth.users (id) on delete set null,
  -- How an uncertain send was settled, when a person had to settle it.
  add column if not exists send_note text;

create index ticket_replies_claimed_by_idx on public.ticket_replies (claimed_by);
create index ticket_replies_created_by_idx on public.ticket_replies (created_by);
create index ticket_replies_sent_by_idx on public.ticket_replies (sent_by);

revoke insert, update on public.ticket_replies from anon, authenticated;

grant insert (
  tenant_id, ticket_id, body, author, edited_by_agent, model,
  prompt_version, created_by, last_error
) on public.ticket_replies to authenticated;

grant update (
  body, author, edited_by_agent, model, prompt_version, status,
  last_error, sending_started_at, claimed_by
) on public.ticket_replies to authenticated;

drop policy if exists ticket_replies_insert_own_tenant on public.ticket_replies;

create policy ticket_replies_insert_own_tenant
  on public.ticket_replies for insert to authenticated
  with check (
    tenant_id in (select private.current_tenant_ids())
    and created_by = (select auth.uid())
    and status = 'draft'
  );

drop policy if exists ticket_replies_update_unsent on public.ticket_replies;

create policy ticket_replies_update_unsent
  on public.ticket_replies for update to authenticated
  using (
    tenant_id in (select private.current_tenant_ids())
    and status in ('draft', 'sending', 'failed')
  )
  with check (
    tenant_id in (select private.current_tenant_ids())
    and status in ('draft', 'sending', 'failed')
    and (claimed_by is null or claimed_by = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- saved_replies: the answers a team gives every day, with placeholders the
-- composer fills from the ticket.
-- ---------------------------------------------------------------------------

create table public.saved_replies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  title text not null check (length(btrim(title)) > 0),
  body text not null check (length(btrim(body)) > 0),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index saved_replies_tenant_idx on public.saved_replies (tenant_id, title);
create index saved_replies_created_by_idx on public.saved_replies (created_by);

create trigger saved_replies_set_updated_at
  before update on public.saved_replies
  for each row execute function public.set_updated_at();

alter table public.saved_replies enable row level security;

create policy saved_replies_select_own_tenant
  on public.saved_replies for select to authenticated
  using (tenant_id in (select private.current_tenant_ids()));

create policy saved_replies_insert_own_tenant
  on public.saved_replies for insert to authenticated
  with check (tenant_id in (select private.current_tenant_ids()));

create policy saved_replies_update_own_tenant
  on public.saved_replies for update to authenticated
  using (tenant_id in (select private.current_tenant_ids()))
  with check (tenant_id in (select private.current_tenant_ids()));

create policy saved_replies_delete_own_tenant
  on public.saved_replies for delete to authenticated
  using (tenant_id in (select private.current_tenant_ids()));

-- ---------------------------------------------------------------------------
-- job_heartbeats: when the recurring job last finished for a workspace, so
-- the app can say when the scheduler has stopped rather than go quiet.
-- ---------------------------------------------------------------------------

create table public.job_heartbeats (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  last_run_at timestamptz not null default now(),
  report jsonb not null default '{}'::jsonb
);

alter table public.job_heartbeats enable row level security;

create policy job_heartbeats_select_own_tenant
  on public.job_heartbeats for select to authenticated
  using (tenant_id in (select private.current_tenant_ids()));

revoke insert, update, delete on public.job_heartbeats from anon, authenticated;

-- ---------------------------------------------------------------------------
-- duplicate_links: the reviewer lookup the advisor flagged.
-- ---------------------------------------------------------------------------

create index if not exists duplicate_links_primary_ticket_idx
  on public.duplicate_links (primary_ticket_id);

create index if not exists duplicate_links_reviewed_by_idx
  on public.duplicate_links (reviewed_by);

create index if not exists channel_secrets_tenant_idx
  on public.channel_secrets (tenant_id);

-- ---------------------------------------------------------------------------
-- correct_classification: an agent disagreeing with Claude.
--
-- Security definer because classifications and the matched-on ticket columns
-- are not writable by members directly. It checks the caller belongs to the
-- ticket's workspace, writes the correction as a new classification marked
-- as the agent's, copies it onto the ticket, and drops the unreviewed
-- duplicate suggestions that the old values produced so matching can run
-- again on the new ones.
-- ---------------------------------------------------------------------------

create or replace function public.correct_classification(
  p_ticket_id uuid,
  p_category public.ticket_category,
  p_order_number text,
  p_customer_name text,
  p_contact_number text,
  p_item_needing_attention text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  v_tenant uuid;
  v_order text := nullif(btrim(p_order_number), '');
  v_name text := nullif(btrim(p_customer_name), '');
  v_phone text := nullif(btrim(p_contact_number), '');
  v_item text := nullif(btrim(p_item_needing_attention), '');
  v_summary text;
  v_items jsonb;
  v_prompt text;
  v_category public.ticket_category;
  t_order text;
  t_name text;
  t_phone text;
  c_item text;
begin
  if caller is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select tenant_id, order_number, customer_name, customer_phone
    into v_tenant, t_order, t_name, t_phone
  from public.tickets
  where id = p_ticket_id
  for update;

  if v_tenant is null
     or v_tenant not in (select private.current_tenant_ids()) then
    raise exception 'ticket not found' using errcode = '42501';
  end if;

  select category, summary, ordered_items, prompt_version, item_needing_attention
    into v_category, v_summary, v_items, v_prompt, c_item
  from public.ticket_classifications
  where ticket_id = p_ticket_id
    and superseded_at is null;

  -- Saving the form unchanged is not a disagreement and should not count
  -- as one.
  if v_category is not distinct from p_category
     and t_order is not distinct from v_order
     and t_name is not distinct from v_name
     and t_phone is not distinct from v_phone
     and c_item is not distinct from v_item then
    return false;
  end if;

  update public.ticket_classifications
  set superseded_at = now()
  where ticket_id = p_ticket_id
    and superseded_at is null;

  insert into public.ticket_classifications (
    tenant_id, ticket_id, category, confidence, summary, customer_name,
    contact_number, order_number, ordered_items, item_needing_attention,
    model, prompt_version, source, created_by
  )
  values (
    v_tenant, p_ticket_id, p_category, null, v_summary, v_name,
    v_phone, v_order, coalesce(v_items, '[]'::jsonb), v_item,
    null, v_prompt, 'agent', caller
  );

  update public.tickets
  set category = p_category,
      order_number = v_order,
      customer_name = v_name,
      customer_phone = v_phone,
      classification_status = 'done',
      classification_error = null,
      classification_retry_at = null
  where id = p_ticket_id;

  delete from public.duplicate_links
  where tenant_id = v_tenant
    and status = 'suggested'
    and (primary_ticket_id = p_ticket_id or duplicate_ticket_id = p_ticket_id);

  return true;
end;
$$;

revoke all on function public.correct_classification(
  uuid, public.ticket_category, text, text, text, text
) from public, anon;
grant execute on function public.correct_classification(
  uuid, public.ticket_category, text, text, text, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- classification_agreement: how often agents disagree with Claude, per
-- prompt version. Security invoker, so RLS scopes it to the caller.
-- ---------------------------------------------------------------------------

create or replace function public.classification_agreement()
returns table (prompt_version text, classified bigint, corrected bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce(c.prompt_version, 'unknown') as prompt_version,
    count(distinct c.ticket_id) filter (where c.source = 'claude') as classified,
    count(distinct c.ticket_id) filter (where c.source = 'agent') as corrected
  from public.ticket_classifications c
  group by 1
  order by 1 desc;
$$;

revoke all on function public.classification_agreement() from public, anon;
grant execute on function public.classification_agreement() to authenticated;

-- ---------------------------------------------------------------------------
-- workspace_members: who is in the caller's workspace, with their email, so
-- a ticket can say who it is assigned to. auth.users is not readable by
-- members, hence security definer, scoped to the caller's own workspaces.
-- ---------------------------------------------------------------------------

create or replace function public.workspace_members()
returns table (user_id uuid, email text, role public.tenant_role)
language sql
stable
security definer
set search_path = ''
as $$
  select tm.user_id, u.email::text, tm.role
  from public.tenant_members tm
  join auth.users u on u.id = tm.user_id
  where tm.tenant_id in (select private.current_tenant_ids())
  order by u.email;
$$;

revoke all on function public.workspace_members() from public, anon;
grant execute on function public.workspace_members() to authenticated;

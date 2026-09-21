-- Row Level Security. Isolation is by tenant: an authenticated user can only
-- reach rows whose tenant_id is one they are a member of.
--
-- Reads cover the whole tenant. Writes are deliberately narrow: agents act on
-- tickets and on duplicate suggestions, while ingestion and classification are
-- written by the service role from server-side routes, which bypasses RLS.

-- ---------------------------------------------------------------------------
-- Tenant lookup helpers.
--
-- These are security definer so they can read tenant_members without tripping
-- the policy that is itself defined in terms of them. search_path is pinned to
-- the empty string, so every reference below is schema-qualified.
-- ---------------------------------------------------------------------------

create or replace function public.current_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select tm.tenant_id
  from public.tenant_members tm
  where tm.user_id = (select auth.uid());
$$;

revoke all on function public.current_tenant_ids() from public;
grant execute on function public.current_tenant_ids() to authenticated;

create or replace function public.is_tenant_admin(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_members tm
    where tm.user_id = (select auth.uid())
      and tm.tenant_id = target_tenant_id
      and tm.role in ('owner', 'admin')
  );
$$;

revoke all on function public.is_tenant_admin(uuid) from public;
grant execute on function public.is_tenant_admin(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. Nothing in this schema is world-readable.
-- ---------------------------------------------------------------------------

alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;
alter table public.channels enable row level security;
alter table public.channel_secrets enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_classifications enable row level security;
alter table public.duplicate_links enable row level security;

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------

create policy tenants_select_own
  on public.tenants for select to authenticated
  using (id in (select public.current_tenant_ids()));

create policy tenants_update_by_admin
  on public.tenants for update to authenticated
  using (public.is_tenant_admin(id))
  with check (public.is_tenant_admin(id));

-- ---------------------------------------------------------------------------
-- tenant_members: everyone in a tenant can see the roster; only owners and
-- admins can change it.
-- ---------------------------------------------------------------------------

create policy tenant_members_select_own
  on public.tenant_members for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));

create policy tenant_members_insert_by_admin
  on public.tenant_members for insert to authenticated
  with check (public.is_tenant_admin(tenant_id));

create policy tenant_members_update_by_admin
  on public.tenant_members for update to authenticated
  using (public.is_tenant_admin(tenant_id))
  with check (public.is_tenant_admin(tenant_id));

create policy tenant_members_delete_by_admin
  on public.tenant_members for delete to authenticated
  using (public.is_tenant_admin(tenant_id));

-- ---------------------------------------------------------------------------
-- channels: visible to the whole tenant, managed by owners and admins. The
-- OAuth flows themselves run server-side with the service role.
-- ---------------------------------------------------------------------------

create policy channels_select_own_tenant
  on public.channels for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));

create policy channels_insert_by_admin
  on public.channels for insert to authenticated
  with check (public.is_tenant_admin(tenant_id));

create policy channels_update_by_admin
  on public.channels for update to authenticated
  using (public.is_tenant_admin(tenant_id))
  with check (public.is_tenant_admin(tenant_id));

create policy channels_delete_by_admin
  on public.channels for delete to authenticated
  using (public.is_tenant_admin(tenant_id));

-- ---------------------------------------------------------------------------
-- channel_secrets: RLS is on and no policy is defined, so neither anon nor
-- authenticated can read or write it. Only the service role reaches it.
-- ---------------------------------------------------------------------------

revoke all on table public.channel_secrets from anon, authenticated;

-- ---------------------------------------------------------------------------
-- tickets: the whole tenant reads them and agents update them (status,
-- assignment, merge state). Rows are created by the ingestion routes.
-- ---------------------------------------------------------------------------

create policy tickets_select_own_tenant
  on public.tickets for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));

create policy tickets_update_own_tenant
  on public.tickets for update to authenticated
  using (tenant_id in (select public.current_tenant_ids()))
  with check (tenant_id in (select public.current_tenant_ids()));

-- ---------------------------------------------------------------------------
-- ticket_classifications: read-only to agents; written by the classifier.
-- ---------------------------------------------------------------------------

create policy ticket_classifications_select_own_tenant
  on public.ticket_classifications for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));

-- ---------------------------------------------------------------------------
-- duplicate_links: agents confirm or reject a suggested duplicate, so they get
-- update as well as select.
-- ---------------------------------------------------------------------------

create policy duplicate_links_select_own_tenant
  on public.duplicate_links for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));

create policy duplicate_links_update_own_tenant
  on public.duplicate_links for update to authenticated
  using (tenant_id in (select public.current_tenant_ids()))
  with check (tenant_id in (select public.current_tenant_ids()));

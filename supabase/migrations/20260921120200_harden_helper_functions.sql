-- Move the tenant lookup helpers out of public so PostgREST does not expose
-- them as /rest/v1/rpc endpoints, and pin every function's search_path.
-- Flagged by the Supabase database linter as lints 0011, 0028 and 0029.

create schema if not exists private;
revoke all on schema private from anon, authenticated;
grant usage on schema private to authenticated;

create or replace function private.current_tenant_ids()
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

create or replace function private.is_tenant_admin(target_tenant_id uuid)
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

revoke all on function private.current_tenant_ids() from public, anon;
revoke all on function private.is_tenant_admin(uuid) from public, anon;
grant execute on function private.current_tenant_ids() to authenticated;
grant execute on function private.is_tenant_admin(uuid) to authenticated;

drop policy tenants_select_own on public.tenants;
drop policy tenants_update_by_admin on public.tenants;
drop policy tenant_members_select_own on public.tenant_members;
drop policy tenant_members_insert_by_admin on public.tenant_members;
drop policy tenant_members_update_by_admin on public.tenant_members;
drop policy tenant_members_delete_by_admin on public.tenant_members;
drop policy channels_select_own_tenant on public.channels;
drop policy channels_insert_by_admin on public.channels;
drop policy channels_update_by_admin on public.channels;
drop policy channels_delete_by_admin on public.channels;
drop policy tickets_select_own_tenant on public.tickets;
drop policy tickets_update_own_tenant on public.tickets;
drop policy ticket_classifications_select_own_tenant on public.ticket_classifications;
drop policy duplicate_links_select_own_tenant on public.duplicate_links;
drop policy duplicate_links_update_own_tenant on public.duplicate_links;

drop function public.current_tenant_ids();
drop function public.is_tenant_admin(uuid);

create policy tenants_select_own
  on public.tenants for select to authenticated
  using (id in (select private.current_tenant_ids()));

create policy tenants_update_by_admin
  on public.tenants for update to authenticated
  using (private.is_tenant_admin(id))
  with check (private.is_tenant_admin(id));

create policy tenant_members_select_own
  on public.tenant_members for select to authenticated
  using (tenant_id in (select private.current_tenant_ids()));

create policy tenant_members_insert_by_admin
  on public.tenant_members for insert to authenticated
  with check (private.is_tenant_admin(tenant_id));

create policy tenant_members_update_by_admin
  on public.tenant_members for update to authenticated
  using (private.is_tenant_admin(tenant_id))
  with check (private.is_tenant_admin(tenant_id));

create policy tenant_members_delete_by_admin
  on public.tenant_members for delete to authenticated
  using (private.is_tenant_admin(tenant_id));

create policy channels_select_own_tenant
  on public.channels for select to authenticated
  using (tenant_id in (select private.current_tenant_ids()));

create policy channels_insert_by_admin
  on public.channels for insert to authenticated
  with check (private.is_tenant_admin(tenant_id));

create policy channels_update_by_admin
  on public.channels for update to authenticated
  using (private.is_tenant_admin(tenant_id))
  with check (private.is_tenant_admin(tenant_id));

create policy channels_delete_by_admin
  on public.channels for delete to authenticated
  using (private.is_tenant_admin(tenant_id));

create policy tickets_select_own_tenant
  on public.tickets for select to authenticated
  using (tenant_id in (select private.current_tenant_ids()));

create policy tickets_update_own_tenant
  on public.tickets for update to authenticated
  using (tenant_id in (select private.current_tenant_ids()))
  with check (tenant_id in (select private.current_tenant_ids()));

create policy ticket_classifications_select_own_tenant
  on public.ticket_classifications for select to authenticated
  using (tenant_id in (select private.current_tenant_ids()));

create policy duplicate_links_select_own_tenant
  on public.duplicate_links for select to authenticated
  using (tenant_id in (select private.current_tenant_ids()));

create policy duplicate_links_update_own_tenant
  on public.duplicate_links for update to authenticated
  using (tenant_id in (select private.current_tenant_ids()))
  with check (tenant_id in (select private.current_tenant_ids()));

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- First-run bootstrap for the v1 single-tenant install.
--
-- A signed-in user with no tenant calls this once to create the tenant and
-- become its owner. It refuses as soon as any tenant exists, so it cannot be
-- used to mint tenants later. v2 replaces it with an invite flow, at which
-- point this function can be dropped.
--
-- It is security definer because tenant_members has no insert policy for a
-- user who is not yet a member of anything, which is the whole point: there is
-- no way to grant yourself membership through the ordinary policies. The
-- Supabase linter flags every security definer function reachable over RPC
-- (lints 0028 and 0029); here that reachability is intentional, and execute is
-- revoked from anon so only a signed-in caller can reach it.

create or replace function public.claim_initial_tenant(tenant_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_name text := nullif(btrim(tenant_name), '');
  new_slug text;
  new_tenant_id uuid;
begin
  if caller is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if clean_name is null then
    raise exception 'tenant name is required' using errcode = '22023';
  end if;

  -- Serialize concurrent callers so two first-run requests cannot both pass
  -- the emptiness check below.
  perform pg_advisory_xact_lock(hashtext('claim_initial_tenant'));

  if exists (select 1 from public.tenants) then
    raise exception 'a tenant already exists' using errcode = '42501';
  end if;

  new_slug := btrim(lower(regexp_replace(clean_name, '[^a-zA-Z0-9]+', '-', 'g')), '-');
  if new_slug = '' then
    new_slug := 'tenant';
  end if;

  insert into public.tenants (name, slug)
  values (clean_name, new_slug)
  returning id into new_tenant_id;

  insert into public.tenant_members (tenant_id, user_id, role)
  values (new_tenant_id, caller, 'owner');

  return new_tenant_id;
end;
$$;

revoke all on function public.claim_initial_tenant(text) from public, anon;
grant execute on function public.claim_initial_tenant(text) to authenticated;

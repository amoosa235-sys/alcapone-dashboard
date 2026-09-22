-- Every channel keeps its credentials in channel_secrets, but they do not all
-- have the same shape: Shopify has an OAuth access token, Microsoft 365 has a
-- client secret belonging to an app registration, Meta has a page token.
--
-- The named columns cover the common ones. `extra` holds whatever a provider
-- needs that they do not, so a new channel type does not need a migration to
-- store its credentials. The table has RLS on with no policies and its grants
-- revoked, so this is still readable only by the service role.

alter table public.channel_secrets
  add column if not exists extra jsonb not null default '{}'::jsonb;

comment on column public.channel_secrets.extra is
  'Provider-specific secret fields that do not fit the named columns.';

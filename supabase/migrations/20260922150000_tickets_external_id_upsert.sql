-- Ingestion needs to be idempotent: Shopify retries any webhook it does not
-- get a 2xx for, so the same event can arrive several times.
--
-- The unique index on (tenant_id, channel_id, external_id) was partial, with
-- `where external_id is not null`. Postgres cannot infer a partial index from
-- a plain `on conflict (columns)`, and PostgREST's upsert only sends columns,
-- so the partial form could not be used as a conflict target. A full unique
-- index behaves the same way here -- Postgres treats nulls as distinct, so
-- rows without an external_id still do not collide -- and can be inferred.

drop index if exists public.tickets_channel_external_id_idx;

create unique index tickets_channel_external_id_idx
  on public.tickets (tenant_id, channel_id, external_id);

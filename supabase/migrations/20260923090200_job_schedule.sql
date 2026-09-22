-- Run the recurring job every five minutes from the database.
--
-- Vercel's Hobby plan allows a cron to run only once a day, which is no way
-- to run a support inbox. Supabase's pg_cron and pg_net are free on every
-- plan: pg_cron keeps the schedule and pg_net makes the request.
--
-- The request carries a bearer token that is generated here, kept in Vault,
-- and never leaves the database: /api/jobs/run reads it back through
-- jobs_runner_token(), which only the service role can call. So nothing had
-- to be copied into Vercel for this to work, and rotating it is one call to
-- vault.update_secret.
--
-- The URL is this deployment's production address. A second environment
-- would schedule its own.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'jobs_runner_token') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'jobs_runner_token',
      'Bearer token the database scheduler sends to /api/jobs/run'
    );
  end if;
end;
$$;

create or replace function public.jobs_runner_token()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'jobs_runner_token'
  limit 1;
$$;

revoke all on function public.jobs_runner_token() from public, anon, authenticated;
grant execute on function public.jobs_runner_token() to service_role;

-- Scheduling under the same name replaces the job rather than adding one.
select cron.schedule(
  'run-support-jobs',
  '*/5 * * * *',
  $job$
    select net.http_get(
      url := 'https://alcapone-dashboard.vercel.app/api/jobs/run',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'jobs_runner_token'
        )
      ),
      timeout_milliseconds := 300000
    );
  $job$
);

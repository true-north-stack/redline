-- Daily retention purge for Redline feedback.
--
-- pg_cron calls the redline-purge edge function, which deletes expired screenshots
-- through the Storage API and then the rows. (Deleting storage.objects rows in SQL
-- would leave the files behind.)
--
-- The job reads two Vault secrets at run time, so nothing sensitive lives in this
-- migration. Create them once per project (SQL editor):
--
--   select vault.create_secret('https://<project-ref>.supabase.co', 'redline_purge_base_url');
--   select vault.create_secret('<long random string>', 'redline_purge_secret');
--
-- and set the same random string on the function:
--
--   supabase secrets set REDLINE_PURGE_SECRET=<long random string>
--
-- Until the secrets exist, the job runs and does nothing.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'redline-purge',
  '17 3 * * *',
  $job$
  select net.http_post(
    url := base.url || '/functions/v1/redline-purge',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-redline-purge-secret', secret.value
    ),
    body := '{}'::jsonb
  )
  from
    (select decrypted_secret as url from vault.decrypted_secrets where name = 'redline_purge_base_url') base,
    (select decrypted_secret as value from vault.decrypted_secrets where name = 'redline_purge_secret') secret;
  $job$
);

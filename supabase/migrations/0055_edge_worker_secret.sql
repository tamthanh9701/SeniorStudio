-- 0055_edge_worker_secret.sql
-- The scheduled worker trigger called the ai-worker Edge Function with no credential at
-- all, and the function is deployed with JWT verification off, so any caller who knew the
-- URL could make it forward a service-role-authenticated worker run (2026-09-17 review).
-- The schedule now sends the AI worker secret, which the function compares before it
-- touches the service role. The secret stays in Vault and is resolved when the job runs,
-- so no copy of it lives in a scheduled command or in this repository.
--
-- The Edge Function ignores unknown headers, so this can be applied before the function
-- that requires the header is deployed; the function is verified through the worker
-- heartbeat, which stops advancing if the trigger is rejected.
-- 0001-0054 remain immutable.

DO $$ BEGIN
  PERFORM cron.unschedule('seniorstudio-ai-worker');
EXCEPTION WHEN others THEN NULL; END $$;

SELECT cron.schedule(
  'seniorstudio-ai-worker',
  '5 seconds',
  $job$
  select net.http_post(
    url := 'https://ykcyfzlkpmohipwraqhi.supabase.co/functions/v1/ai-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'seniorstudio_ai_worker_secret' order by created_at desc limit 1)
    ),
    body := '{}'::jsonb
  );
  $job$
);

-- Point the one-minute database schedule at the deployed Supabase Edge Function.
do $$ begin
  perform cron.unschedule('seniorstudio-ai-worker');
exception when others then null; end $$;

select cron.schedule(
  'seniorstudio-ai-worker',
  '* * * * *',
  $$select net.http_post(
    url := 'https://ykcyfzlkpmohipwraqhi.supabase.co/functions/v1/ai-worker',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );$$
);

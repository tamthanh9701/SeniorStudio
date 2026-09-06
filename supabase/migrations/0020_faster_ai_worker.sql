-- Fire the worker every 5 seconds so queued jobs are claimed promptly
-- instead of waiting up to 60 seconds for the previous 1-minute schedule.
do $$ begin
  perform cron.unschedule('seniorstudio-ai-worker');
exception when others then null; end $$;

select cron.schedule(
  'seniorstudio-ai-worker',
  '5 seconds',
  $$select net.http_post(
    url := 'https://ykcyfzlkpmohipwraqhi.supabase.co/functions/v1/ai-worker',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );$$
);

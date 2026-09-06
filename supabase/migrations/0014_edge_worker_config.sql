-- Keep the scheduled Edge Function's shared secret encrypted in Supabase Vault.
create or replace function public.get_ai_worker_config()
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'seniorstudio_ai_worker_secret'
  order by created_at desc
  limit 1;

  if v_secret is null then
    raise exception 'WORKER_SECRET_NOT_CONFIGURED' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'url', 'https://senior-studio.vercel.app/api/internal/ai-worker',
    'secret', v_secret
  );
end;
$$;

revoke all on function public.get_ai_worker_config() from public, anon, authenticated;
grant execute on function public.get_ai_worker_config() to service_role;

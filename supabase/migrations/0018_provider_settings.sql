-- User-configurable AI provider credentials, replacing env-based provider configuration.
create table public.provider_settings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null check (provider in ('openai', 'google')),
  api_key text not null check (char_length(btrim(api_key)) between 1 and 512),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider)
);

alter table public.provider_settings enable row level security;
create policy "Owners can manage provider settings" on public.provider_settings
  for all to authenticated
  using (workspace_id in (select public.current_workspace_ids()))
  with check (workspace_id in (select public.current_workspace_ids()));
create index provider_settings_workspace on public.provider_settings(workspace_id);

-- The API key never leaves the server; the UI reads only a masked presence flag.
create or replace function public.upsert_provider_setting(p_provider text, p_api_key text)
returns void language plpgsql security definer set search_path = public as $$
declare v_workspace uuid;
begin
  if auth.role() <> 'authenticated' then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select workspace_id into v_workspace from public.current_workspace_ids() limit 1;
  if v_workspace is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_provider not in ('openai', 'google') or char_length(btrim(coalesce(p_api_key, ''))) not between 1 and 512 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  insert into public.provider_settings(workspace_id, provider, api_key)
  values (v_workspace, p_provider, btrim(p_api_key))
  on conflict (workspace_id, provider) do update set api_key = excluded.api_key, updated_at = now();
end; $$;

create or replace function public.delete_provider_setting(p_provider text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'authenticated' then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  delete from public.provider_settings where provider = p_provider and workspace_id in (select public.current_workspace_ids());
end; $$;

-- Service-role lookup used by the worker instead of process environment.
create or replace function public.get_provider_api_key(p_provider text)
returns text language plpgsql security definer set search_path = public as $$
declare v_key text;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501'; end if;
  select api_key into v_key from public.provider_settings where provider = p_provider limit 1;
  return v_key;
end; $$;

revoke all on function public.upsert_provider_setting(text, text) from public, anon;
grant execute on function public.upsert_provider_setting(text, text) to authenticated;
revoke all on function public.delete_provider_setting(text) from public, anon;
grant execute on function public.delete_provider_setting(text) to authenticated;
revoke all on function public.get_provider_api_key(text) from public, anon, authenticated;
grant execute on function public.get_provider_api_key(text) to service_role;

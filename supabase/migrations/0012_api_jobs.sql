-- API-first image jobs, temporary inputs, leases, Realtime, and scheduled worker trigger.

-- Remove the browser-only runtime without changing commit_asset_version.
drop function if exists public.retry_browser_job(uuid);
drop function if exists public.fail_browser_job(uuid, text, text, text, text);
drop function if exists public.complete_browser_image_job(uuid, text, uuid, uuid, text, text, integer, integer, bigint, text, text, jsonb);
drop function if exists public.complete_browser_chat_job(uuid, text, text, text);
drop function if exists public.set_browser_job_state(uuid, text, text, text);
drop function if exists public.renew_browser_job_lease(uuid, text, integer);
drop function if exists public.claim_browser_job(text, integer);
drop function if exists public.enqueue_browser_job(uuid, uuid, uuid, text, text, uuid);
drop policy if exists "Service role manages chat messages" on public.chat_messages;
drop policy if exists "Owners can read chat messages" on public.chat_messages;
drop policy if exists "Service role manages bridge workers" on public.browser_bridge_workers;
drop policy if exists "Owners can read bridge workers" on public.browser_bridge_workers;
drop policy if exists "Service role manages browser jobs" on public.browser_jobs;
drop policy if exists "Owners can read browser jobs" on public.browser_jobs;
drop policy if exists "Service role manages chat threads" on public.chat_threads;
drop policy if exists "Owners can read chat threads" on public.chat_threads;
drop table if exists public.chat_messages;
drop table if exists public.browser_bridge_workers;
drop table if exists public.browser_jobs;
drop table if exists public.chat_threads;

-- Cleanly evolve the legacy durable run table.
alter table public.generation_runs rename to ai_jobs;
alter table public.batch_items rename column generation_run_id to ai_job_id;

alter table public.ai_jobs drop constraint if exists generation_runs_origin_check;
alter table public.ai_jobs drop constraint if exists generation_runs_operation_check;
alter table public.ai_jobs drop constraint if exists generation_runs_status_check;
drop policy if exists "Users can manage generation runs in their workspace" on public.ai_jobs;

alter table public.ai_jobs add column requested_by uuid references auth.users(id);
alter table public.ai_jobs add column provider text;
alter table public.ai_jobs add column model text;
alter table public.ai_jobs add column attempt_count integer not null default 0;
alter table public.ai_jobs add column lease_owner text;
alter table public.ai_jobs add column lease_expires_at timestamptz;
alter table public.ai_jobs add column provider_request_id text;
alter table public.ai_jobs add column provider_status text;
alter table public.ai_jobs add column output jsonb not null default '{}'::jsonb;
alter table public.ai_jobs add column error_message text;
alter table public.ai_jobs add column version_id uuid references public.asset_versions(id);
alter table public.ai_jobs add column updated_at timestamptz not null default now();

update public.ai_jobs
set provider_request_id = openai_response_id,
    operation = case operation when 'generate' then 'text_to_image' when 'edit' then 'inpaint' else operation end,
    status = case status when 'pending' then 'queued' when 'succeeded' then 'succeeded' when 'failed' then 'failed' else status end,
    provider = 'openai',
    model = 'openai/gpt-image-2',
    requested_by = coalesce((select wm.supabase_user_id from public.workspace_members wm where wm.workspace_id = ai_jobs.workspace_id and wm.supabase_user_id is not null limit 1), auth.uid()),
    output = coalesce(output, '{}'::jsonb) || jsonb_build_object('migrated_legacy_run', true),
    completed_at = coalesce(completed_at, created_at),
    updated_at = coalesce(completed_at, created_at);

alter table public.ai_jobs rename column request to input;
alter table public.ai_jobs drop column openai_response_id;
alter table public.ai_jobs drop column origin;
alter table public.ai_jobs alter column requested_by set not null;
alter table public.ai_jobs alter column provider set not null;
alter table public.ai_jobs alter column model set not null;
alter table public.ai_jobs alter column input set not null;
alter table public.ai_jobs alter column input drop default;
alter table public.ai_jobs alter column status set default 'queued';
alter table public.ai_jobs add constraint ai_jobs_operation_check check (operation in ('text_to_image', 'inpaint'));
alter table public.ai_jobs add constraint ai_jobs_provider_check check (provider in ('openai', 'fal'));
alter table public.ai_jobs add constraint ai_jobs_status_check check (status in ('queued', 'submitting', 'processing', 'persisting', 'succeeded', 'failed', 'canceled'));

create table public.ai_job_inputs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid unique references public.ai_jobs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  parent_version_id uuid not null references public.asset_versions(id) on delete cascade,
  kind text not null default 'mask' check (kind = 'mask'),
  storage_path text not null unique,
  mime_type text not null check (mime_type = 'image/png'),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 52428800),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.ai_jobs enable row level security;
alter table public.ai_job_inputs enable row level security;
create policy "Owners can read ai jobs" on public.ai_jobs for select to authenticated
using (workspace_id in (select public.current_workspace_ids()));
create policy "Owners can read ai job inputs" on public.ai_job_inputs for select to authenticated
using (workspace_id in (select public.current_workspace_ids()));
create policy "Service role manages ai jobs" on public.ai_jobs for all to service_role using (true) with check (true);
create policy "Service role manages ai job inputs" on public.ai_job_inputs for all to service_role using (true) with check (true);

create or replace function public.enqueue_ai_job(
  p_workspace_id uuid, p_project_id uuid, p_requested_by uuid, p_operation text,
  p_provider text, p_model text, p_prompt text, p_count integer, p_size text,
  p_quality text, p_asset_id uuid default null, p_parent_version_id uuid default null,
  p_mask_storage_path text default null
) returns public.ai_jobs
language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs; v_parent_asset uuid; v_parent_project uuid;
begin
  if auth.role() <> 'authenticated' or auth.uid() <> p_requested_by
     or p_workspace_id not in (select public.current_workspace_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.projects where id = p_project_id and workspace_id = p_workspace_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if char_length(btrim(coalesce(p_prompt, ''))) not between 1 and 8000
     or p_operation not in ('text_to_image', 'inpaint')
     or p_provider not in ('openai', 'fal')
     or p_quality not in ('low', 'medium', 'high', 'auto') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if p_model not in ('openai/gpt-image-2', 'fal/fal-ai/flux/dev', 'fal/fal-ai/flux-pro/v1/fill')
     or (p_model = 'openai/gpt-image-2' and p_provider <> 'openai')
     or (p_model like 'fal/%' and p_provider <> 'fal')
     or (p_model = 'fal/fal-ai/flux/dev' and p_operation <> 'text_to_image')
     or (p_model = 'fal/fal-ai/flux-pro/v1/fill' and p_operation <> 'inpaint') then
    raise exception 'INVALID_MODEL' using errcode = '22023';
  end if;
  if p_operation = 'text_to_image' then
    if p_count not between 1 and 4 or p_asset_id is not null or p_parent_version_id is not null or p_mask_storage_path is not null then
      raise exception 'INVALID_REQUEST' using errcode = '22023';
    end if;
    if p_size not in ('1024x1024', '1536x1024', '1024x1536', 'auto')
       or (p_provider = 'fal' and p_size = 'auto') then
      raise exception 'INVALID_REQUEST' using errcode = '22023';
    end if;
  else
    if p_count <> 1 or p_asset_id is null or p_parent_version_id is null or p_mask_storage_path is null then
      raise exception 'INVALID_REQUEST' using errcode = '22023';
    end if;
    select av.asset_id, a.project_id into v_parent_asset, v_parent_project
    from public.asset_versions av join public.assets a on a.id = av.asset_id where av.id = p_parent_version_id;
    if v_parent_asset is null or v_parent_project <> p_project_id then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if v_parent_asset <> p_asset_id then raise exception 'VERSION_CONFLICT' using errcode = '23000'; end if;
    if not exists (select 1 from public.ai_job_inputs where storage_path = p_mask_storage_path and workspace_id = p_workspace_id and project_id = p_project_id and asset_id = p_asset_id and parent_version_id = p_parent_version_id and expires_at > now() and job_id is null) then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  insert into public.ai_jobs(workspace_id, project_id, requested_by, asset_id, parent_version_id,
    operation, provider, model, status, input)
  values (p_workspace_id, p_project_id, p_requested_by, p_asset_id, p_parent_version_id,
    p_operation, p_provider, p_model, 'queued', jsonb_build_object('prompt', btrim(p_prompt), 'count', p_count, 'size', p_size, 'quality', p_quality, 'mask_storage_path', p_mask_storage_path))
  returning * into v_job;
  return v_job;
end; $$;

create or replace function public.claim_ai_jobs(p_worker_id text, p_limit integer, p_lease_seconds integer)
returns setof public.ai_jobs language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_worker_id, ''))) = 0 or p_limit not between 1 and 10 or p_lease_seconds not between 30 and 600 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  return query
  with claimed as (
    select id from public.ai_jobs
    where completed_at is null and (
      status = 'queued'
      or (status in ('submitting', 'processing') and lease_expires_at < now())
    )
    order by created_at, id for update skip locked limit p_limit
  )
  update public.ai_jobs j set status = case when j.status = 'processing' then 'processing' else 'submitting' end,
    lease_owner = p_worker_id, lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    attempt_count = attempt_count + 1, updated_at = now()
  from claimed where j.id = claimed.id returning j.*;
end; $$;

create or replace function public.assert_ai_job_lease(p_job_id uuid, p_worker_id text)
returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs;
begin
  select * into v_job from public.ai_jobs where id = p_job_id and lease_owner = p_worker_id and lease_expires_at > now() for update;
  if v_job.id is null then raise exception 'LEASE_NOT_OWNED' using errcode = '42501'; end if;
  return v_job;
end; $$;

create or replace function public.renew_ai_job_lease(p_job_id uuid, p_worker_id text, p_lease_seconds integer)
returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501'; end if;
  perform public.assert_ai_job_lease(p_job_id, p_worker_id);
  update public.ai_jobs set lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where id = p_job_id returning * into v_job; return v_job;
end; $$;

create or replace function public.set_ai_job_processing(p_job_id uuid, p_worker_id text, p_provider_request_id text, p_provider_status text, p_metadata jsonb default '{}'::jsonb)
returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501'; end if;
  perform public.assert_ai_job_lease(p_job_id, p_worker_id);
  update public.ai_jobs set status = 'processing', provider_request_id = p_provider_request_id,
    provider_status = p_provider_status, output = output || coalesce(p_metadata, '{}'::jsonb), updated_at = now()
  where id = p_job_id returning * into v_job; return v_job;
end; $$;

create or replace function public.set_ai_job_persisting(p_job_id uuid, p_worker_id text)
returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501'; end if;
  perform public.assert_ai_job_lease(p_job_id, p_worker_id);
  update public.ai_jobs set status = 'persisting', updated_at = now() where id = p_job_id returning * into v_job; return v_job;
end; $$;

create or replace function public.complete_ai_job(p_job_id uuid, p_worker_id text, p_asset_id uuid, p_version_id uuid, p_provider_request_id text, p_provider_status text, p_output jsonb)
returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501'; end if;
  perform public.assert_ai_job_lease(p_job_id, p_worker_id);
  if not exists (select 1 from public.asset_versions where id = p_version_id and asset_id = p_asset_id) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  update public.ai_jobs set status = 'succeeded', asset_id = p_asset_id, version_id = p_version_id,
    provider_request_id = p_provider_request_id, provider_status = p_provider_status, output = coalesce(p_output, '{}'::jsonb),
    lease_owner = null, lease_expires_at = null, error_code = null, error_message = null, updated_at = now(), completed_at = now()
  where id = p_job_id returning * into v_job; return v_job;
end; $$;

create or replace function public.fail_ai_job(p_job_id uuid, p_worker_id text, p_error_code text, p_error_message text, p_provider_status text default null)
returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501'; end if;
  perform public.assert_ai_job_lease(p_job_id, p_worker_id);
  update public.ai_jobs set status = 'failed', error_code = p_error_code, error_message = left(p_error_message, 4000),
    provider_status = coalesce(p_provider_status, provider_status), lease_owner = null, lease_expires_at = null, updated_at = now(), completed_at = now()
  where id = p_job_id returning * into v_job; return v_job;
end; $$;

create or replace function public.cancel_ai_job(p_job_id uuid)
returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs;
begin
  if auth.role() <> 'authenticated' then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_job from public.ai_jobs where id = p_job_id and workspace_id in (select public.current_workspace_ids()) for update;
  if v_job.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_job.status in ('succeeded', 'failed', 'canceled', 'persisting') or (v_job.provider = 'openai' and v_job.status in ('submitting', 'processing')) then
    raise exception 'JOB_NOT_CANCELABLE' using errcode = 'P0001';
  end if;
  update public.ai_jobs set status = 'canceled', lease_owner = null, lease_expires_at = null, updated_at = now(), completed_at = now()
  where id = p_job_id returning * into v_job; return v_job;
end; $$;

revoke all on function public.enqueue_ai_job(uuid, uuid, uuid, text, text, text, text, integer, text, text, uuid, uuid, text) from public, anon;
grant execute on function public.enqueue_ai_job(uuid, uuid, uuid, text, text, text, text, integer, text, text, uuid, uuid, text) to authenticated;
revoke all on function public.cancel_ai_job(uuid) from public, anon;
grant execute on function public.cancel_ai_job(uuid) to authenticated;
revoke all on function public.assert_ai_job_lease(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_ai_jobs(text, integer, integer), public.renew_ai_job_lease(uuid, text, integer), public.set_ai_job_processing(uuid, text, text, text, jsonb), public.set_ai_job_persisting(uuid, text), public.complete_ai_job(uuid, text, uuid, uuid, text, text, jsonb), public.fail_ai_job(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_ai_jobs(text, integer, integer), public.renew_ai_job_lease(uuid, text, integer), public.set_ai_job_processing(uuid, text, text, text, jsonb), public.set_ai_job_persisting(uuid, text), public.complete_ai_job(uuid, text, uuid, uuid, text, text, jsonb), public.fail_ai_job(uuid, text, text, text, text) to service_role;

create index ai_jobs_claim_order on public.ai_jobs(created_at, id) where status = 'queued' and completed_at is null;
create index ai_jobs_workspace_project_order on public.ai_jobs(workspace_id, project_id, created_at desc, id desc);
create index ai_jobs_active_lease_expiry on public.ai_jobs(lease_expires_at) where lease_expires_at is not null and completed_at is null;
create index ai_job_inputs_expiry on public.ai_job_inputs(expires_at) where job_id is null;

alter publication supabase_realtime add table public.ai_jobs;

-- Supabase-hosted one-minute trigger. The deployment-specific URL is configured
-- by the following forward migration after the Edge Function is deployed.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

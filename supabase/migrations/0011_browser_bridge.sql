-- Browser-backed ChatGPT bridge, durable job queue, and atomic asset commits.

create or replace function public.commit_asset_version(
  p_workspace_id uuid,
  p_project_id uuid,
  p_asset_id uuid,
  p_version_id uuid,
  p_parent_version_id uuid,
  p_asset_name text,
  p_kind text,
  p_source text,
  p_storage_path text,
  p_mime_type text,
  p_width integer,
  p_height integer,
  p_byte_size bigint,
  p_prompt text,
  p_provider_response_id text,
  p_metadata jsonb
) returns table(asset_id uuid, version_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_workspace uuid;
  v_asset_project uuid;
  v_parent_asset uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select workspace_id into v_project_workspace
  from public.projects where id = p_project_id;
  if v_project_workspace is null or v_project_workspace <> p_workspace_id then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_kind not in ('generated', 'uploaded') then
    raise exception 'INVALID_ASSET_KIND' using errcode = '22023';
  end if;
  if p_source not in ('chatgpt', 'web_openai', 'upload', 'flattened') then
    raise exception 'INVALID_VERSION_SOURCE' using errcode = '22023';
  end if;
  if p_mime_type not in ('image/png', 'image/jpeg', 'image/webp')
     or p_width <= 0 or p_height <= 0 or p_byte_size <= 0 or p_byte_size > 52428800 then
    raise exception 'UNSUPPORTED_IMAGE' using errcode = '22023';
  end if;

  select project_id into v_asset_project
  from public.assets where id = p_asset_id for update;
  if v_asset_project is null then
    insert into public.assets (id, project_id, name, kind)
    values (p_asset_id, p_project_id, coalesce(nullif(btrim(p_asset_name), ''), 'Untitled'), p_kind);
  elsif v_asset_project <> p_project_id then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_parent_version_id is not null then
    select av.asset_id into v_parent_asset
    from public.asset_versions av where av.id = p_parent_version_id;
    if v_parent_asset is null or v_parent_asset <> p_asset_id then
      raise exception 'VERSION_CONFLICT' using errcode = '23000';
    end if;
  end if;

  insert into public.asset_versions (
    id, asset_id, parent_version_id, source, storage_path, mime_type,
    width, height, byte_size, prompt, provider_response_id, metadata
  ) values (
    p_version_id, p_asset_id, p_parent_version_id, p_source, p_storage_path, p_mime_type,
    p_width, p_height, p_byte_size::integer, p_prompt, p_provider_response_id,
    coalesce(p_metadata, '{}'::jsonb)
  );

  update public.assets
  set current_version_id = p_version_id,
      name = coalesce(nullif(btrim(p_asset_name), ''), name),
      updated_at = now()
  where id = p_asset_id;

  return query select p_asset_id, p_version_id;
end;
$$;

revoke all on function public.commit_asset_version(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, integer, integer, bigint, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.commit_asset_version(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, integer, integer, bigint, text, text, jsonb) to service_role;

create table public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  provider text not null default 'chatgpt_web' check (provider = 'chatgpt_web'),
  provider_conversation_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.browser_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  operation text not null check (operation in ('chat', 'generate', 'edit')),
  prompt text not null,
  parent_version_id uuid references public.asset_versions(id),
  status text not null default 'queued' check (status in (
    'queued', 'claimed', 'submitting', 'generating', 'downloading', 'persisting',
    'succeeded', 'failed', 'needs_login', 'needs_review', 'canceled'
  )),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  asset_id uuid references public.assets(id),
  version_id uuid references public.asset_versions(id),
  provider_conversation_url text,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  kind text not null check (kind in ('text', 'image')),
  content text not null,
  asset_id uuid references public.assets(id),
  version_id uuid references public.asset_versions(id),
  job_id uuid references public.browser_jobs(id),
  created_at timestamptz not null default now()
);

create table public.browser_bridge_workers (
  worker_id text primary key,
  status text not null check (status in ('online', 'needs_login', 'degraded', 'offline')),
  last_seen_at timestamptz not null default now(),
  active_job_id uuid references public.browser_jobs(id),
  browser_url text,
  error_code text,
  error_message text
);

create unique index browser_jobs_one_active_per_thread
on public.browser_jobs(thread_id)
where status in ('queued', 'claimed', 'submitting', 'generating', 'downloading', 'persisting');
create index browser_jobs_claim_order on public.browser_jobs(created_at, id) where status = 'queued';
create index chat_messages_thread_order on public.chat_messages(thread_id, created_at, id);

create or replace function public.enqueue_browser_job(
  p_workspace_id uuid,
  p_project_id uuid,
  p_thread_id uuid,
  p_operation text,
  p_prompt text,
  p_parent_version_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread public.chat_threads;
  v_message public.chat_messages;
  v_job public.browser_jobs;
  v_parent_project uuid;
  v_title text;
begin
  if auth.role() <> 'authenticated' or p_workspace_id not in (select public.current_workspace_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_operation not in ('chat', 'generate', 'edit') or char_length(btrim(p_prompt)) not between 1 and 8000 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if not exists (select 1 from public.projects where id = p_project_id and workspace_id = p_workspace_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_thread_id is null then
    v_title := left(btrim(p_prompt), 80);
    insert into public.chat_threads(workspace_id, project_id, title)
    values (p_workspace_id, p_project_id, v_title)
    returning * into v_thread;
  else
    select * into v_thread from public.chat_threads
    where id = p_thread_id and workspace_id = p_workspace_id and project_id = p_project_id
    for update;
    if v_thread.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  end if;

  if exists (select 1 from public.browser_jobs where thread_id = v_thread.id and status in ('queued','claimed','submitting','generating','downloading','persisting')) then
    raise exception 'THREAD_BUSY' using errcode = 'P0001';
  end if;

  if p_operation = 'edit' then
    select a.project_id into v_parent_project
    from public.asset_versions av join public.assets a on a.id = av.asset_id
    where av.id = p_parent_version_id;
    if v_parent_project is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if v_parent_project <> p_project_id then raise exception 'VERSION_CONFLICT' using errcode = '23000'; end if;
  elsif p_parent_version_id is not null then
    raise exception 'VERSION_CONFLICT' using errcode = '23000';
  end if;

  insert into public.browser_jobs(workspace_id, project_id, thread_id, operation, prompt, parent_version_id)
  values (p_workspace_id, p_project_id, v_thread.id, p_operation, btrim(p_prompt), p_parent_version_id)
  returning * into v_job;

  insert into public.chat_messages(thread_id, role, kind, content, job_id)
  values (v_thread.id, 'user', 'text', btrim(p_prompt), v_job.id)
  returning * into v_message;

  update public.chat_threads set updated_at = now() where id = v_thread.id returning * into v_thread;
  return jsonb_build_object('thread', to_jsonb(v_thread), 'message', to_jsonb(v_message), 'job', to_jsonb(v_job));
exception when unique_violation then
  raise exception 'THREAD_BUSY' using errcode = 'P0001';
end;
$$;

revoke all on function public.enqueue_browser_job(uuid, uuid, uuid, text, text, uuid) from public, anon;
grant execute on function public.enqueue_browser_job(uuid, uuid, uuid, text, text, uuid) to authenticated;

create or replace function public.claim_browser_job(p_worker_id text, p_lease_seconds integer)
returns setof public.browser_jobs
language plpgsql
security definer
set search_path = public
as $$
declare v_job public.browser_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501'; end if;
  if p_lease_seconds < 30 or p_lease_seconds > 600 then raise exception 'INVALID_LEASE' using errcode = '22023'; end if;

  update public.browser_jobs
  set status = 'needs_review', error_code = 'WORKER_INTERRUPTED_AFTER_SUBMISSION',
      error_message = 'Worker lease expired after prompt submission; manual review required.',
      lease_owner = null, lease_expires_at = null, updated_at = now(), completed_at = now()
  where status in ('submitting','generating','downloading','persisting') and lease_expires_at < now();

  select * into v_job from public.browser_jobs
  where status = 'queued' or (status = 'claimed' and lease_expires_at < now())
  order by created_at, id for update skip locked limit 1;
  if v_job.id is null then return; end if;

  update public.browser_jobs
  set status = 'claimed', lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempt_count = attempt_count + 1, updated_at = now()
  where id = v_job.id returning * into v_job;

  insert into public.browser_bridge_workers(worker_id, status, last_seen_at, active_job_id)
  values (p_worker_id, 'online', now(), v_job.id)
  on conflict (worker_id) do update set status = 'online', last_seen_at = now(), active_job_id = v_job.id,
    error_code = null, error_message = null;
  return next v_job;
end;
$$;

create or replace function public.renew_browser_job_lease(p_job_id uuid, p_worker_id text, p_lease_seconds integer)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501'; end if;
  update public.browser_jobs set lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where id = p_job_id and lease_owner = p_worker_id and lease_expires_at > now()
    and status in ('claimed','submitting','generating','downloading','persisting');
  return found;
end; $$;

create or replace function public.set_browser_job_state(p_job_id uuid, p_worker_id text, p_status text, p_provider_conversation_url text default null)
returns public.browser_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.browser_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501'; end if;
  if p_status not in ('submitting','generating','downloading','persisting') then raise exception 'INVALID_STATE' using errcode = '22023'; end if;
  update public.browser_jobs set status = p_status,
    provider_conversation_url = coalesce(p_provider_conversation_url, provider_conversation_url), updated_at = now()
  where id = p_job_id and lease_owner = p_worker_id and lease_expires_at > now()
  returning * into v_job;
  if v_job.id is null then raise exception 'LEASE_NOT_OWNED' using errcode = '42501'; end if;
  return v_job;
end; $$;

create or replace function public.complete_browser_chat_job(p_job_id uuid, p_worker_id text, p_assistant_text text, p_provider_conversation_url text)
returns public.browser_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.browser_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501'; end if;
  select * into v_job from public.browser_jobs where id = p_job_id and lease_owner = p_worker_id and lease_expires_at > now() for update;
  if v_job.id is null then raise exception 'LEASE_NOT_OWNED' using errcode = '42501'; end if;
  insert into public.chat_messages(thread_id, role, kind, content, job_id)
  values (v_job.thread_id, 'assistant', 'text', left(coalesce(p_assistant_text,''), 32768), v_job.id);
  update public.chat_threads set provider_conversation_url = p_provider_conversation_url, updated_at = now() where id = v_job.thread_id;
  update public.browser_jobs set status = 'succeeded', provider_conversation_url = p_provider_conversation_url,
    lease_owner = null, lease_expires_at = null, updated_at = now(), completed_at = now()
  where id = v_job.id returning * into v_job;
  update public.browser_bridge_workers set active_job_id = null, last_seen_at = now() where worker_id = p_worker_id;
  return v_job;
end; $$;

create or replace function public.complete_browser_image_job(
  p_job_id uuid, p_worker_id text, p_asset_id uuid, p_version_id uuid,
  p_storage_path text, p_mime_type text, p_width integer, p_height integer, p_byte_size bigint,
  p_assistant_text text, p_provider_conversation_url text, p_metadata jsonb
) returns public.browser_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.browser_jobs; v_asset_name text;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501'; end if;
  select * into v_job from public.browser_jobs where id = p_job_id and lease_owner = p_worker_id and lease_expires_at > now() for update;
  if v_job.id is null then raise exception 'LEASE_NOT_OWNED' using errcode = '42501'; end if;
  if v_job.operation not in ('generate','edit') then raise exception 'INVALID_STATE' using errcode = '22023'; end if;
  v_asset_name := left(v_job.prompt, 100);
  perform public.commit_asset_version(v_job.workspace_id, v_job.project_id, p_asset_id, p_version_id,
    v_job.parent_version_id, v_asset_name, 'generated', 'chatgpt', p_storage_path, p_mime_type,
    p_width, p_height, p_byte_size, v_job.prompt, p_job_id::text,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('browser_job_id', p_job_id, 'conversation_url', p_provider_conversation_url));
  if nullif(btrim(coalesce(p_assistant_text,'')), '') is not null then
    insert into public.chat_messages(thread_id, role, kind, content, job_id)
    values (v_job.thread_id, 'assistant', 'text', left(p_assistant_text, 32768), v_job.id);
  end if;
  insert into public.chat_messages(thread_id, role, kind, content, asset_id, version_id, job_id)
  values (v_job.thread_id, 'assistant', 'image', coalesce(nullif(btrim(p_assistant_text),''), v_asset_name), p_asset_id, p_version_id, v_job.id);
  update public.chat_threads set provider_conversation_url = p_provider_conversation_url, updated_at = now() where id = v_job.thread_id;
  update public.browser_jobs set status = 'succeeded', asset_id = p_asset_id, version_id = p_version_id,
    provider_conversation_url = p_provider_conversation_url, lease_owner = null, lease_expires_at = null,
    updated_at = now(), completed_at = now() where id = v_job.id returning * into v_job;
  update public.browser_bridge_workers set active_job_id = null, last_seen_at = now() where worker_id = p_worker_id;
  return v_job;
end; $$;

create or replace function public.fail_browser_job(p_job_id uuid, p_worker_id text, p_status text, p_error_code text, p_error_message text)
returns public.browser_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.browser_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501'; end if;
  if p_status not in ('failed','needs_login','needs_review') then raise exception 'INVALID_STATE' using errcode = '22023'; end if;
  update public.browser_jobs set status = p_status, error_code = p_error_code,
    error_message = left(p_error_message, 4000), lease_owner = null, lease_expires_at = null,
    updated_at = now(), completed_at = now()
  where id = p_job_id and lease_owner = p_worker_id and lease_expires_at > now()
  returning * into v_job;
  if v_job.id is null then raise exception 'LEASE_NOT_OWNED' using errcode = '42501'; end if;
  update public.browser_bridge_workers set active_job_id = null, last_seen_at = now(),
    status = case when p_status = 'needs_login' then 'needs_login' else 'degraded' end,
    error_code = p_error_code, error_message = left(p_error_message, 4000)
  where worker_id = p_worker_id;
  return v_job;
end; $$;

create or replace function public.retry_browser_job(p_job_id uuid)
returns public.browser_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.browser_jobs;
begin
  if auth.role() <> 'authenticated' then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_job from public.browser_jobs
  where id = p_job_id and workspace_id in (select public.current_workspace_ids()) for update;
  if v_job.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_job.status not in ('failed','needs_login','needs_review') then raise exception 'INVALID_STATE' using errcode = '22023'; end if;
  if exists (select 1 from public.browser_jobs where thread_id = v_job.thread_id and id <> v_job.id and status in ('queued','claimed','submitting','generating','downloading','persisting')) then
    raise exception 'THREAD_BUSY' using errcode = 'P0001';
  end if;
  update public.browser_jobs set status = 'queued', lease_owner = null, lease_expires_at = null,
    error_code = null, error_message = null, completed_at = null, updated_at = now()
  where id = p_job_id returning * into v_job;
  return v_job;
exception when unique_violation then raise exception 'THREAD_BUSY' using errcode = 'P0001';
end; $$;

revoke all on function public.claim_browser_job(text, integer) from public, anon, authenticated;
revoke all on function public.renew_browser_job_lease(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.set_browser_job_state(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.complete_browser_chat_job(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.complete_browser_image_job(uuid, text, uuid, uuid, text, text, integer, integer, bigint, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.fail_browser_job(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_browser_job(text, integer), public.renew_browser_job_lease(uuid, text, integer),
  public.set_browser_job_state(uuid, text, text, text), public.complete_browser_chat_job(uuid, text, text, text),
  public.complete_browser_image_job(uuid, text, uuid, uuid, text, text, integer, integer, bigint, text, text, jsonb),
  public.fail_browser_job(uuid, text, text, text, text) to service_role;
revoke all on function public.retry_browser_job(uuid) from public, anon;
grant execute on function public.retry_browser_job(uuid) to authenticated;

alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;
alter table public.browser_jobs enable row level security;
alter table public.browser_bridge_workers enable row level security;

create policy "Owners can read chat threads" on public.chat_threads for select to authenticated
using (workspace_id in (select public.current_workspace_ids()));
create policy "Owners can read chat messages" on public.chat_messages for select to authenticated
using (thread_id in (select id from public.chat_threads where workspace_id in (select public.current_workspace_ids())));
create policy "Owners can read browser jobs" on public.browser_jobs for select to authenticated
using (workspace_id in (select public.current_workspace_ids()));
create policy "Owners can read bridge workers" on public.browser_bridge_workers for select to authenticated
using (exists (select 1 from public.current_workspace_ids()));

create policy "Service role manages chat threads" on public.chat_threads for all to service_role using (true) with check (true);
create policy "Service role manages chat messages" on public.chat_messages for all to service_role using (true) with check (true);
create policy "Service role manages browser jobs" on public.browser_jobs for all to service_role using (true) with check (true);
create policy "Service role manages bridge workers" on public.browser_bridge_workers for all to service_role using (true) with check (true);

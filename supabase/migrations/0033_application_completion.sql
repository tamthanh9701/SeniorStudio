-- 0033_application_completion.sql
-- Consolidated corrective DDL/RPC for 0029/0030/0031/0032 runtime gaps.
-- Depends on 0032_atomic_style_mutations.sql.
-- Single forward migration; existing history 0029–0032 immutable.

-- 1. Allow optional same-workspace active Style on Projects text jobs (fix 0028 block)
--    Refine the check so module='projects' allows style_id when valid, rejects when invalid.
create or replace function public.enqueue_text_to_image_job(
  p_workspace_id uuid, p_project_id uuid, p_requested_by uuid,
  p_provider text, p_model text, p_prompt text, p_count integer, p_size text,
  p_quality text, p_style_id uuid default null, p_original_prompt text default null,
  p_module text default 'projects', p_cost_mode text default null,
  p_requested_model_id text default null, p_reference_ids uuid[] default '{}',
  p_temperature numeric default null
) returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs;
begin
  if auth.role() <> 'authenticated' or auth.uid() <> p_requested_by
     or p_workspace_id not in (select public.current_workspace_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_module not in ('projects','style') or char_length(btrim(coalesce(p_prompt,''))) not between 1 and 8000
     or p_provider not in ('openai','google') or p_quality not in ('low','medium','high','auto')
     or p_count not between 1 and 4 or p_size not in ('1024x1024','1536x1024','1024x1536','auto') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if p_cost_mode is not null and p_cost_mode not in ('strict_style','strict_1000','balanced','quality') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if (p_provider = 'openai' and p_model <> 'openai/gpt-image-2')
     or (p_provider = 'google' and (p_model !~ '^google/[a-z0-9._-]+$' or p_size = 'auto' or p_quality <> 'auto')) then
    raise exception 'INVALID_MODEL' using errcode = '22023';
  end if;

  -- Explicit null/type validation for new optional fields
  if p_requested_model_id is not null and char_length(btrim(p_requested_model_id)) = 0 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if p_temperature is not null and (p_temperature < 0 or p_temperature > 2) then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  if p_module = 'projects' then
    if p_project_id is null or not exists (select 1 from public.projects where id=p_project_id and workspace_id=p_workspace_id) then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
    -- Allow optional same-workspace active Style for Projects
    if p_style_id is not null then
      if not exists (select 1 from public.styles where id=p_style_id and workspace_id=p_workspace_id and status='active') then
        raise exception 'STYLE_NOT_ACTIVE' using errcode = 'P0002';
      end if;
    end if;
  else
    if p_project_id is not null or not exists (select 1 from public.styles where id=p_style_id and workspace_id=p_workspace_id and status='active') then
      raise exception 'STYLE_NOT_ACTIVE' using errcode = 'P0002';
    end if;
  end if;

  insert into public.ai_jobs(workspace_id,project_id,module,requested_by,operation,provider,model,status,input)
  values (p_workspace_id,p_project_id,p_module,p_requested_by,'text_to_image',p_provider,p_model,'queued',
    jsonb_build_object(
      'prompt',btrim(p_prompt),'count',p_count,'size',p_size,'quality',p_quality,
      'style_id',p_style_id,'original_prompt',p_original_prompt,
      'requested_model_id',coalesce(p_requested_model_id,p_model),
      'reference_ids',coalesce(p_reference_ids,'{}'::uuid[]),
      'temperature',p_temperature
    )
      || case when p_cost_mode is null then '{}'::jsonb else jsonb_build_object('cost_mode',p_cost_mode) end)
  returning * into v_job;
  return v_job;
end; $$;

-- 2. Image-to-image RPC
create or replace function public.enqueue_image_to_image_job(
  p_workspace_id uuid, p_requested_by uuid, p_provider text, p_model text,
  p_prompt text, p_count integer, p_size text, p_quality text,
  p_style_id uuid, p_source_version_id uuid,
  p_original_prompt text default null, p_cost_mode text default 'strict_style',
  p_requested_model_id text default null, p_reference_ids uuid[] default '{}',
  p_temperature numeric default null
) returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs; v_source_version record;
begin
  if auth.role() <> 'authenticated' or auth.uid() <> p_requested_by
     or p_workspace_id not in (select public.current_workspace_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_count not between 1 and 4 or p_size not in ('1024x1024','1536x1024','1024x1536','auto')
     or p_quality not in ('low','medium','high','auto')
     or char_length(btrim(coalesce(p_prompt,''))) not between 1 and 8000 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  if p_cost_mode is not null and p_cost_mode not in ('strict_style','strict_1000','balanced','quality') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  if (p_provider = 'openai' and p_model <> 'openai/gpt-image-2')
     or (p_provider = 'google' and (p_model !~ '^google/[a-z0-9._-]+$' or p_size = 'auto' or p_quality <> 'auto')) then
    raise exception 'INVALID_MODEL' using errcode = '22023';
  end if;

  -- Source must be style-owned
  select * into v_source_version
  from public.asset_versions av
  join public.assets a on a.id = av.asset_id
  where av.id = p_source_version_id and a.style_id = p_style_id and a.project_id is null
    and a.workspace_id = p_workspace_id;

  if v_source_version.id is null then
    raise exception 'SOURCE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Style must be active
  if not exists (select 1 from public.styles where id=p_style_id and workspace_id=p_workspace_id and status='active') then
    raise exception 'STYLE_NOT_ACTIVE' using errcode = 'P0002';
  end if;

  insert into public.ai_jobs(workspace_id,project_id,module,requested_by,operation,provider,model,status,input,source_version_id)
  values (p_workspace_id,null,'style',p_requested_by,'image_to_image',p_provider,p_model,'queued',
    jsonb_build_object(
      'prompt',btrim(p_prompt),'count',p_count,'size',p_size,'quality',p_quality,
      'style_id',p_style_id,'source_version_id',p_source_version_id,
      'original_prompt',p_original_prompt,
      'requested_model_id',coalesce(p_requested_model_id,p_model),
      'reference_ids',coalesce(p_reference_ids,'{}'::uuid[]),
      'temperature',p_temperature
    )
      || case when p_cost_mode is null then '{}'::jsonb else jsonb_build_object('cost_mode',p_cost_mode) end,
    p_source_version_id)
  returning * into v_job;
  return v_job;
end; $$;

-- Grants
revoke all on function public.enqueue_text_to_image_job(uuid,uuid,uuid,text,text,text,integer,text,text,uuid,text,text,text,text,uuid[],numeric) from public,anon;
grant execute on function public.enqueue_text_to_image_job(uuid,uuid,uuid,text,text,text,integer,text,text,uuid,text,text,text,text,uuid[],numeric) to authenticated;
revoke all on function public.enqueue_image_to_image_job(uuid,uuid,text,text,text,integer,text,text,uuid,uuid,text,text,text,uuid[],numeric) from public,anon;
grant execute on function public.enqueue_image_to_image_job(uuid,uuid,text,text,text,integer,text,text,uuid,uuid,text,text,text,uuid[],numeric) to authenticated;

-- 3. Drop legacy RPC overloads safety net
drop function if exists public.reserve_ai_quota(uuid, text, integer, uuid);
drop function if exists public.begin_ai_provider(uuid, uuid);
drop function if exists public.begin_ai_provider(uuid, uuid, text);
drop function if exists public.release_ai_reservation(uuid, text);

-- 4. Fail AI job RPC with release
create or replace function public.fail_ai_job(
  p_job_id uuid, p_worker_id text, p_error_code text, p_error_message text
) returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs; v_reservation_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select * into v_job from public.ai_jobs
  where id = p_job_id and lease_owner = p_worker_id
  for update;

  if v_job.id is null then
    raise exception 'LEASE_NOT_OWNED' using errcode = '23505';
  end if;

  if v_job.status not in ('submitting', 'processing', 'persisting') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  -- Release reserved quota if exists
  v_reservation_id := v_job.quota_reservation_id;

  update public.ai_jobs
  set status = 'failed',
      error_code = p_error_code,
      error_message = p_error_message,
      lease_owner = null,
      lease_expires_at = null,
      completed_at = now(),
      updated_at = now()
  where id = p_job_id
  returning * into v_job;

  -- Release reservation
  perform public.release_ai_reservation(v_reservation_id);

  return v_job;
end; $$;

revoke all on function public.fail_ai_job(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.fail_ai_job(uuid, text, text, text) to service_role;

-- 5. Cancel AI job with reservation release
create or replace function public.cancel_ai_job(p_job_id uuid) returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs; v_reservation_id uuid;
begin
  if auth.role() <> 'authenticated' then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id and workspace_id in (select public.current_workspace_ids()) for update;
  if v_job.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_job.status <> 'queued' then raise exception 'JOB_NOT_CANCELABLE' using errcode = 'P0001'; end if;

  v_reservation_id := v_job.quota_reservation_id;

  update public.ai_jobs set status='canceled',completed_at=now(),updated_at=now(),lease_owner=null,lease_expires_at=null where id=p_job_id returning * into v_job;

  -- Release reserved quota
  perform public.release_ai_reservation(v_reservation_id);

  return v_job;
end; $$;

-- 6. Expire stale jobs with reservation release
create or replace function public.expire_stale_ai_jobs(p_limit integer default 20) returns setof public.ai_jobs
language plpgsql security definer set search_path=public as $$
declare v_job record; v_reservation_id uuid;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode='42501'; end if;

  for v_job in
    select id, quota_reservation_id from public.ai_jobs
    where status in ('submitting','processing','persisting') and completed_at is null and lease_expires_at<now()
    order by lease_expires_at,id limit p_limit
    for update skip locked
  loop
    v_reservation_id := v_job.quota_reservation_id;

    update public.ai_jobs
    set status='failed',error_code='PROVIDER_OUTCOME_UNKNOWN',
        error_message='Worker lease expired after provider processing began; automatic retry is disabled to avoid duplicate provider charges',
        lease_owner=null,lease_expires_at=null,completed_at=now(),updated_at=now()
    where id=v_job.id;

    -- Release reserved quota
    perform public.release_ai_reservation(v_reservation_id);
  end loop;

  return query select * from public.ai_jobs
  where status='failed' and error_code='PROVIDER_OUTCOME_UNKNOWN' and completed_at >= now() - interval '1 minute';
end; $$;

-- 7. Begin AI job provider with quota charge
create or replace function public.begin_ai_job_provider(
  p_job_id uuid, p_worker_id text
) returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs; v_reservation_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select * into v_job from public.ai_jobs
  where id = p_job_id and lease_owner = p_worker_id
  for update;

  if v_job.id is null then
    raise exception 'LEASE_NOT_OWNED' using errcode = '23505';
  end if;

  if v_job.status <> 'submitting' then
    raise exception 'PROVIDER_ALREADY_STARTED' using errcode = '22023';
  end if;

  -- Quota must be reserved before begin
  v_reservation_id := v_job.quota_reservation_id;
  if v_reservation_id is null then
    raise exception 'NO_QUOTA_RESERVED' using errcode = '22023';
  end if;

  -- Charge quota (held -> charged)
  perform public.begin_ai_provider(v_reservation_id);

  update public.ai_jobs
  set status = 'processing',
      provider_started_at = now(),
      lease_expires_at = now() + make_interval(secs => 150)
  where id = p_job_id
  returning * into v_job;

  return v_job;
end; $$;

revoke all on function public.begin_ai_job_provider(uuid, text) from public, anon, authenticated;
grant execute on function public.begin_ai_job_provider(uuid, text) to service_role;

-- 8. Resolve AI job persistence (DB+Storage ambiguity resolver)
create or replace function public.resolve_ai_job_persistence(
  p_job_id uuid, p_worker_id text, p_version_ids uuid[]
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs; v_committed boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select * into v_job from public.ai_jobs
  where id = p_job_id
  for update;

  if v_job.id is null then
    return jsonb_build_object('state', 'unknown');
  end if;

  -- If succeeded with correct output versions, it's committed
  if v_job.status = 'succeeded' then
    -- Verify output results reference our version IDs
    if v_job.output ? 'results' then
      v_committed := (
        select count(*) = array_length(p_version_ids, 1)
        from jsonb_array_elements(v_job.output->'results') r
        where (r->>'version_id')::uuid = any(p_version_ids)
      );
    end if;

    if v_committed then return jsonb_build_object('state', 'committed', 'job', to_jsonb(v_job));
    end if;
  end if;

  -- If not succeeded, still has lease, is persisting, and has no results -> abort
  if v_job.status in ('processing', 'persisting')
     and v_job.lease_owner = p_worker_id
     and (v_job.output is null or not (v_job.output ? 'results')
          or jsonb_array_length(v_job.output->'results') = 0)
  then
    update public.ai_jobs
    set status = 'failed',
        error_code = 'PERSISTENCE_FAILED',
        lease_owner = null,
        lease_expires_at = null,
        completed_at = now(),
        updated_at = now()
    where id = p_job_id
    returning * into v_job;

    return jsonb_build_object('state', 'aborted');
  end if;

  -- Unknown state, no mutation
  return jsonb_build_object('state', 'unknown');
end; $$;

revoke all on function public.resolve_ai_job_persistence(uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function public.resolve_ai_job_persistence(uuid, text, uuid[]) to service_role;

-- 9. Add quota fields to ai_jobs if not present
do $$
begin
  if not exists (select 1 from information_schema.columns where table_name = 'ai_jobs' and column_name = 'quota_reservation_id') then
    alter table public.ai_jobs add column quota_reservation_id uuid references public.ai_quota_reservations(id) on delete set null;
    create index if not exists ai_jobs_reservation_idx on public.ai_jobs(quota_reservation_id);
  end if;

  if not exists (select 1 from information_schema.columns where table_name = 'ai_jobs' and column_name = 'provider_started_at') then
    alter table public.ai_jobs add column provider_started_at timestamptz;
  end if;
end $$;

-- 10. Brain quota functions
create or replace function public.reserve_brain_quota(
  p_workspace_id uuid, p_reservation_id uuid
) returns void language plpgsql security definer set search_path = public as $$
declare v_limit integer; v_day date := (now() at time zone 'utc')::date;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select case when brain_limit >= 0 then brain_limit else 200 end into v_limit
  from public.workspace_ai_limits where workspace_id = p_workspace_id;

  if v_limit is null then
    insert into public.workspace_ai_limits (workspace_id) values (p_workspace_id) on conflict do nothing;
    v_limit := 200;
  end if;

  if v_limit = 0 then
    raise exception 'quota_exceeded' using errcode = 'P0001';
  end if;

  insert into public.ai_quota_reservations (id, workspace_id, day, route_group, units, state)
  values (p_reservation_id, p_workspace_id, v_day, 'brain', 1, 'reserved');
end; $$;

create or replace function public.begin_brain_operation(p_reservation_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  perform public.begin_ai_provider(p_reservation_id);
end; $$;

create or replace function public.release_brain_reservation(p_reservation_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  perform public.release_ai_reservation(p_reservation_id);
end; $$;

-- Grants for brain quota
revoke all on function public.reserve_brain_quota(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_brain_quota(uuid, uuid) to service_role;
revoke all on function public.begin_brain_operation(uuid) from public, anon, authenticated;
grant execute on function public.begin_brain_operation(uuid) to service_role;
revoke all on function public.release_brain_reservation(uuid) from public, anon, authenticated;
grant execute on function public.release_brain_reservation(uuid) to service_role;

-- 11. GET quota status (authenticated read-only endpoint)
create or replace function public.get_ai_quota_status(p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_day date := (now() at time zone 'utc')::date;
begin
  return jsonb_build_object(
    'day', v_day,
    'image', jsonb_build_object(
      'limit', coalesce((select image_limit from public.workspace_ai_limits where workspace_id = p_workspace_id), 100),
      'held', coalesce((select held from public.workspace_ai_usage where workspace_id = p_workspace_id and day = v_day and route_group = 'image'), 0),
      'charged', coalesce((select charged from public.workspace_ai_usage where workspace_id = p_workspace_id and day = v_day and route_group = 'image'), 0)
    ),
    'brain', jsonb_build_object(
      'limit', coalesce((select brain_limit from public.workspace_ai_limits where workspace_id = p_workspace_id), 200),
      'held', coalesce((select held from public.workspace_ai_usage where workspace_id = p_workspace_id and day = v_day and route_group = 'brain'), 0),
      'charged', coalesce((select charged from public.workspace_ai_usage where workspace_id = p_workspace_id and day = v_day and route_group = 'brain'), 0)
    )
  );
end; $$;

-- Grant authenticated read access (RLS already limits to same workspace)
grant execute on function public.get_ai_quota_status(uuid) to authenticated;

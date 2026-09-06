-- Replace the unused fal provider contract with Pollinations text-to-image.
alter table public.ai_jobs drop constraint if exists ai_jobs_provider_check;
alter table public.ai_jobs add constraint ai_jobs_provider_check
  check (provider in ('openai', 'pollinations'));

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
     or p_provider not in ('openai', 'pollinations')
     or p_quality not in ('low', 'medium', 'high', 'auto') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if p_model not in ('openai/gpt-image-2', 'pollinations/zimage')
     or (p_model = 'openai/gpt-image-2' and p_provider <> 'openai')
     or (p_model = 'pollinations/zimage' and (p_provider <> 'pollinations' or p_operation <> 'text_to_image')) then
    raise exception 'INVALID_MODEL' using errcode = '22023';
  end if;
  if p_operation = 'text_to_image' then
    if p_count not between 1 and 4 or p_asset_id is not null or p_parent_version_id is not null or p_mask_storage_path is not null then
      raise exception 'INVALID_REQUEST' using errcode = '22023';
    end if;
    if p_size not in ('1024x1024', '1536x1024', '1024x1536', 'auto')
       or (p_provider = 'pollinations' and p_size = 'auto') then
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

create or replace function public.cancel_ai_job(p_job_id uuid)
returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs;
begin
  if auth.role() <> 'authenticated' then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_job from public.ai_jobs where id = p_job_id and workspace_id in (select public.current_workspace_ids()) for update;
  if v_job.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_job.status in ('succeeded', 'failed', 'canceled', 'persisting')
     or (v_job.provider in ('openai', 'pollinations') and v_job.status in ('submitting', 'processing')) then
    raise exception 'JOB_NOT_CANCELABLE' using errcode = 'P0001';
  end if;
  update public.ai_jobs set status = 'canceled', lease_owner = null, lease_expires_at = null, updated_at = now(), completed_at = now()
  where id = p_job_id returning * into v_job;
  return v_job;
end; $$;

-- Store cost_mode atomically with enqueue_ai_job insertion.
drop function if exists public.enqueue_ai_job(uuid, uuid, uuid, text, text, text, text, integer, text, text, uuid, uuid, text, uuid, text, text);
drop function if exists public.enqueue_ai_job(uuid, uuid, uuid, text, text, text, text, integer, text, text, uuid, uuid, text, uuid, text);

create function public.enqueue_ai_job(
  p_workspace_id uuid, p_project_id uuid, p_requested_by uuid, p_operation text,
  p_provider text, p_model text, p_prompt text, p_count integer, p_size text,
  p_quality text, p_asset_id uuid default null, p_parent_version_id uuid default null,
  p_mask_storage_path text default null, p_style_id uuid default null,
  p_original_prompt text default null, p_module text default 'projects',
  p_cost_mode text default null
) returns public.ai_jobs
language plpgsql security definer set search_path = public as $$
declare
  v_job public.ai_jobs;
  v_style_workspace uuid;
  v_parent_project uuid;
begin
  if auth.role() <> 'authenticated' or auth.uid() <> p_requested_by
     or p_workspace_id not in (select public.current_workspace_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_module not in ('projects', 'style') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if p_module = 'style' then
    if p_project_id is not null then
      raise exception 'INVALID_REQUEST' using errcode = '22023';
    end if;
    select workspace_id into v_style_workspace from public.styles
      where id = p_style_id and status = 'active' and workspace_id = p_workspace_id;
    if v_style_workspace is null then
      raise exception 'STYLE_NOT_ACTIVE' using errcode = 'P0002';
    end if;
  else
    if not exists (select 1 from public.projects where id = p_project_id and workspace_id = p_workspace_id) then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;
  if char_length(btrim(coalesce(p_prompt, ''))) not between 1 and 8000
     or p_operation not in ('text_to_image', 'inpaint')
     or p_provider not in ('openai', 'google')
     or p_quality not in ('low', 'medium', 'high', 'auto') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if p_cost_mode is not null and p_cost_mode not in ('strict_style', 'strict_1000', 'balanced', 'quality') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if (p_model = 'openai/gpt-image-2' and p_provider <> 'openai')
     or (p_provider = 'openai' and p_model <> 'openai/gpt-image-2')
     or (p_provider = 'google' and (p_model !~ '^google/[a-z0-9._-]+$' or p_operation <> 'text_to_image')) then
    raise exception 'INVALID_MODEL' using errcode = '22023';
  end if;
  if p_style_id is not null and not exists (
    select 1 from public.styles where id = p_style_id and status = 'active'
      and workspace_id = p_workspace_id
  ) then
    raise exception 'STYLE_NOT_ACTIVE' using errcode = 'P0002';
  end if;
  if p_operation = 'text_to_image' then
    if p_count not between 1 and 4 or p_asset_id is not null or p_parent_version_id is not null or p_mask_storage_path is not null then
      raise exception 'INVALID_REQUEST' using errcode = '22023';
    end if;
    if p_size not in ('1024x1024', '1536x1024', '1024x1536', 'auto')
       or (p_provider = 'google' and (p_size = 'auto' or p_quality <> 'auto')) then
      raise exception 'INVALID_REQUEST' using errcode = '22023';
    end if;
  else
    if p_count <> 1 or p_asset_id is null or p_parent_version_id is null or p_mask_storage_path is null then
      raise exception 'INVALID_REQUEST' using errcode = '22023';
    end if;
    select av.asset_id, a.project_id into v_job.asset_id, v_parent_project
    from public.asset_versions av join public.assets a on a.id = av.asset_id where av.id = p_parent_version_id;
    if v_parent_project is null or v_parent_project <> p_project_id then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  end if;

  insert into public.ai_jobs(workspace_id, project_id, module, requested_by, asset_id, parent_version_id,
    operation, provider, model, status, input)
  values (p_workspace_id, p_project_id, p_module, p_requested_by, p_asset_id, p_parent_version_id,
    p_operation, p_provider, p_model, 'queued',
    jsonb_build_object('prompt', btrim(p_prompt), 'count', p_count, 'size', p_size, 'quality', p_quality,
      'mask_storage_path', p_mask_storage_path, 'style_id', p_style_id, 'original_prompt', p_original_prompt)
    || case when p_cost_mode is null then '{}'::jsonb else jsonb_build_object('cost_mode', p_cost_mode) end)
  returning * into v_job;
  return v_job;
end; $$;

revoke all on function public.enqueue_ai_job(uuid, uuid, uuid, text, text, text, text, integer, text, text, uuid, uuid, text, uuid, text, text, text) from public, anon;
grant execute on function public.enqueue_ai_job(uuid, uuid, uuid, text, text, text, text, integer, text, text, uuid, uuid, text, uuid, text, text, text) to authenticated;

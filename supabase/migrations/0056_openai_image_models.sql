-- 0056_openai_image_models.sql
-- Two newer OpenAI image models join the catalog, so the enqueue RPCs can no longer pin a
-- single OpenAI id. The whitelist becomes one helper, public.is_supported_model(): the
-- OpenAI ids live there, the Google ids keep the shape check they already had.
--
-- Each function below is the live definition with exactly that clause replaced and
-- nothing else touched; CREATE OR REPLACE keeps the existing grants. A later OpenAI model
-- means updating the helper and the catalog, not five functions.
-- 0001-0055 remain immutable.

CREATE OR REPLACE FUNCTION public.is_supported_model(p_provider text, p_model text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_provider = 'openai' THEN p_model IN (
      'openai/gpt-image-2',
      'openai/gpt-image-2.5-sunburst',
      'openai/gpt-image-2.5-flare'
    )
    WHEN p_provider = 'google' THEN p_model ~ '^google/[a-z0-9._-]+$'
    ELSE false
  END
$$;

-- enqueue_text_to_image_job(uuid,uuid,uuid,text,text,text,integer,text,text,uuid,text,text,text,text,uuid[],numeric)
CREATE OR REPLACE FUNCTION public.enqueue_text_to_image_job(p_workspace_id uuid, p_project_id uuid, p_requested_by uuid, p_provider text, p_model text, p_prompt text, p_count integer, p_size text, p_quality text, p_style_id uuid DEFAULT NULL::uuid, p_original_prompt text DEFAULT NULL::text, p_module text DEFAULT 'projects'::text, p_cost_mode text DEFAULT NULL::text, p_requested_model_id text DEFAULT NULL::text, p_reference_ids uuid[] DEFAULT '{}'::uuid[], p_temperature numeric DEFAULT NULL::numeric)
 RETURNS ai_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if not public.is_supported_model(p_provider, p_model)
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
end; $function$;

-- enqueue_text_to_image_job(uuid,uuid,uuid,text,text,text,integer,text,text,uuid,text,text,text)
CREATE OR REPLACE FUNCTION public.enqueue_text_to_image_job(p_workspace_id uuid, p_project_id uuid, p_requested_by uuid, p_provider text, p_model text, p_prompt text, p_count integer, p_size text, p_quality text, p_style_id uuid DEFAULT NULL::uuid, p_original_prompt text DEFAULT NULL::text, p_module text DEFAULT 'projects'::text, p_cost_mode text DEFAULT NULL::text)
 RETURNS ai_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ declare v_job public.ai_jobs; begin if auth.role() <> 'authenticated' or auth.uid() <> p_requested_by or p_workspace_id not in (select public.current_workspace_ids()) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if; if p_module not in ('projects','style') or char_length(btrim(coalesce(p_prompt,''))) not between 1 and 8000 or p_provider not in ('openai','google') or p_quality not in ('low','medium','high','auto') or p_count not between 1 and 4 or p_size not in ('1024x1024','1536x1024','1024x1536','auto') then raise exception 'INVALID_REQUEST' using errcode = '22023'; end if; if p_cost_mode is not null and p_cost_mode not in ('strict_style','strict_1000','balanced','quality') then raise exception 'INVALID_REQUEST' using errcode = '22023'; end if; if not public.is_supported_model(p_provider, p_model) or (p_provider = 'google' and (p_model !~ '^google/[a-z0-9._-]+$' or p_size = 'auto' or p_quality <> 'auto')) then raise exception 'INVALID_MODEL' using errcode = '22023'; end if; if p_module = 'projects' then if p_project_id is null or not exists (select 1 from public.projects where id=p_project_id and workspace_id=p_workspace_id) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if; if p_style_id is not null then raise exception 'INVALID_REQUEST' using errcode = '22023'; end if; else if p_project_id is not null or not exists (select 1 from public.styles where id=p_style_id and workspace_id=p_workspace_id and status='active') then raise exception 'STYLE_NOT_ACTIVE' using errcode = 'P0002'; end if; end if; insert into public.ai_jobs(workspace_id,project_id,module,requested_by,operation,provider,model,status,input) values (p_workspace_id,p_project_id,p_module,p_requested_by,'text_to_image',p_provider,p_model,'queued',jsonb_build_object('prompt',btrim(p_prompt),'count',p_count,'size',p_size,'quality',p_quality,'style_id',p_style_id,'original_prompt',p_original_prompt) || case when p_cost_mode is null then '{}'::jsonb else jsonb_build_object('cost_mode',p_cost_mode) end) returning * into v_job; return v_job; end; $function$;

-- enqueue_image_to_image_job(uuid,uuid,text,text,text,integer,text,text,uuid,uuid,text,text,text,uuid[],numeric)
CREATE OR REPLACE FUNCTION public.enqueue_image_to_image_job(p_workspace_id uuid, p_requested_by uuid, p_provider text, p_model text, p_prompt text, p_count integer, p_size text, p_quality text, p_style_id uuid, p_source_version_id uuid, p_original_prompt text DEFAULT NULL::text, p_cost_mode text DEFAULT 'strict_style'::text, p_requested_model_id text DEFAULT NULL::text, p_reference_ids uuid[] DEFAULT '{}'::uuid[], p_temperature numeric DEFAULT NULL::numeric)
 RETURNS ai_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if not public.is_supported_model(p_provider, p_model)
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
end; $function$;

-- enqueue_project_image_to_image_job(uuid,uuid,text,text,text,integer,text,text,uuid,text,text)
CREATE OR REPLACE FUNCTION public.enqueue_project_image_to_image_job(p_workspace_id uuid, p_requested_by uuid, p_provider text, p_model text, p_prompt text, p_count integer, p_size text, p_quality text, p_source_version_id uuid, p_cost_mode text DEFAULT 'strict_1000'::text, p_background text DEFAULT NULL::text)
 RETURNS ai_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_job public.ai_jobs; v_reservation uuid; v_asset uuid; v_project uuid;
BEGIN
  IF auth.role() <> 'authenticated' OR auth.uid() <> p_requested_by
     OR p_workspace_id NOT IN (SELECT public.current_workspace_ids()) THEN
    RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002';
  END IF;

  IF p_count NOT BETWEEN 1 AND 4 OR p_size NOT IN ('1024x1024','1536x1024','1024x1536','auto')
     OR p_quality NOT IN ('low','medium','high','auto')
     OR char_length(btrim(coalesce(p_prompt,''))) NOT BETWEEN 1 AND 8000 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
  END IF;
  IF p_cost_mode IS NOT NULL AND p_cost_mode NOT IN ('strict_style','strict_1000','balanced','quality') THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
  END IF;
  IF p_background IS NOT NULL AND p_background <> 'transparent' THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
  END IF;
  IF not public.is_supported_model(p_provider, p_model)
     OR (p_provider = 'google' AND (p_model !~ '^google/[a-z0-9._-]+$' OR p_size = 'auto' OR p_quality <> 'auto')) THEN
    RAISE EXCEPTION 'INVALID_MODEL' USING errcode = '22023';
  END IF;

  -- The source must be a project-owned version of this workspace: a style image
  -- never produces a project job, which would bypass the style definition.
  SELECT av.asset_id, a.project_id INTO v_asset, v_project
    FROM public.asset_versions av
    JOIN public.assets a ON a.id = av.asset_id
    WHERE av.id = p_source_version_id AND a.project_id IS NOT NULL AND a.workspace_id = p_workspace_id;
  IF v_asset IS NULL THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND' USING errcode = 'P0002'; END IF;

  v_reservation := public.reserve_ai_quota_internal(p_workspace_id,'image',p_count);
  INSERT INTO public.ai_jobs(workspace_id,project_id,module,requested_by,operation,provider,model,status,input,asset_id,parent_version_id,source_version_id)
    VALUES (p_workspace_id, v_project, 'projects', p_requested_by, 'image_to_image', p_provider, p_model, 'queued',
      jsonb_build_object(
        'prompt', btrim(p_prompt), 'count', p_count, 'size', p_size, 'quality', p_quality,
        'source_version_id', p_source_version_id, 'reference_ids', '[]'::jsonb)
      || CASE WHEN p_cost_mode IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cost_mode', p_cost_mode) END
      || CASE WHEN p_background = 'transparent' THEN jsonb_build_object('background','transparent') ELSE '{}'::jsonb END,
      v_asset, p_source_version_id, p_source_version_id)
    RETURNING * INTO v_job;
  RETURN public.attach_ai_quota_reservation_internal(v_job.id, v_reservation);
END; $function$;

-- enqueue_inpaint_job(uuid,uuid,text,text,text,text)
CREATE OR REPLACE FUNCTION public.enqueue_inpaint_job(p_mask_id uuid, p_requested_by uuid, p_provider text, p_model text, p_prompt text, p_quality text)
 RETURNS ai_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ declare v_mask public.ai_job_inputs; v_job public.ai_jobs; v_asset_project uuid; begin if auth.role() <> 'authenticated' or auth.uid() <> p_requested_by then raise exception 'NOT_FOUND' using errcode='P0002'; end if; select * into v_mask from public.ai_job_inputs where id=p_mask_id and job_id is null and expires_at>now() for update; if v_mask.id is null or v_mask.workspace_id not in (select public.current_workspace_ids()) then raise exception 'NOT_FOUND' using errcode='P0002'; end if; if v_mask.project_id is null or not exists (select 1 from public.projects where id=v_mask.project_id and workspace_id=v_mask.workspace_id) then raise exception 'NOT_FOUND' using errcode='P0002'; end if; select a.project_id into v_asset_project from public.assets a where a.id=v_mask.asset_id; if v_asset_project is null or v_asset_project<>v_mask.project_id then raise exception 'NOT_FOUND' using errcode='P0002'; end if; if not public.is_supported_model(p_provider, p_model) then raise exception 'INVALID_MODEL' using errcode='22023'; end if; if char_length(btrim(coalesce(p_prompt,''))) not between 1 and 8000 or p_quality not in ('low','medium','high','auto') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if; if not exists (select 1 from public.asset_versions where id=v_mask.parent_version_id and asset_id=v_mask.asset_id) then raise exception 'VERSION_CONFLICT' using errcode='23000'; end if; insert into public.ai_jobs(workspace_id,project_id,module,requested_by,asset_id,parent_version_id,operation,provider,model,status,input) values (v_mask.workspace_id,v_mask.project_id,'projects',p_requested_by,v_mask.asset_id,v_mask.parent_version_id,'inpaint',p_provider,p_model,'queued',jsonb_build_object('prompt',btrim(p_prompt),'count',1,'size','auto','quality',p_quality,'mask_id',p_mask_id,'mask_storage_path',v_mask.storage_path)) returning * into v_job; update public.ai_job_inputs set job_id=v_job.id where id=p_mask_id; return v_job; end; $function$;


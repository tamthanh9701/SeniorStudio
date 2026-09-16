-- 0047_project_background_flag.sql
-- The project module needs the same transparent-background export as a style.
-- 0043's plan assumed enqueue_image_to_image_job_v2 could serve a project, but
-- that function requires a style-owned source (a.style_id = p_style_id and
-- a.project_id is null) and records module='style', so a project variation was
-- never possible. This adds the missing primitive instead of a _v3 wrapper that
-- no caller could use: the source must be project-owned, the module is
-- 'projects', and p_background travels on the job input the worker reads.
-- 0001-0046 remain immutable.

CREATE OR REPLACE FUNCTION public.enqueue_project_image_to_image_job(
  p_workspace_id uuid, p_requested_by uuid, p_provider text, p_model text,
  p_prompt text, p_count integer, p_size text, p_quality text,
  p_source_version_id uuid,
  p_cost_mode text default 'strict_1000',
  p_background text default null
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  IF (p_provider = 'openai' AND p_model <> 'openai/gpt-image-2')
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
END; $$;
REVOKE ALL ON FUNCTION public.enqueue_project_image_to_image_job(uuid,uuid,text,text,text,integer,text,text,uuid,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_project_image_to_image_job(uuid,uuid,text,text,text,integer,text,text,uuid,text,text) TO authenticated;

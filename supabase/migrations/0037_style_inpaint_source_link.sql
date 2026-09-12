-- Style inpaint source linkage: enqueue_style_group_job must record the source
-- asset and parent version on ai_jobs so the worker can resolve the inpaint
-- source image (worker.prepInputImages reads job.parent_version_id for inpaint)
-- and the completion path can validate lineage against job.asset_id.
-- Without these columns the style inpaint job fails INVALID_REQUEST in the
-- worker before any provider call.

CREATE OR REPLACE FUNCTION public.enqueue_style_group_job(
  p_style_id uuid, p_requested_by uuid, p_operation text, p_model text,
  p_packet jsonb, p_mask_id uuid DEFAULT NULL
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.ai_jobs; v_workspace uuid; v_reservation uuid; v_mask public.ai_job_inputs;
  v_source uuid; v_asset uuid; v_count integer; v_provider text; v_input jsonb; v_ref jsonb;
BEGIN
  IF auth.role() <> 'authenticated' OR auth.uid() <> p_requested_by THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode='P0002'; END IF;
  SELECT workspace_id INTO v_workspace FROM public.styles WHERE id=p_style_id AND status='active' AND workspace_id IN (SELECT public.current_workspace_ids());
  IF v_workspace IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_ACTIVE' USING errcode='P0002'; END IF;
  IF p_operation NOT IN ('text_to_image','image_to_image','inpaint') OR p_packet IS NULL OR jsonb_typeof(p_packet) <> 'object' OR (p_packet->>'packet_version')::int <> 1 OR (p_packet->>'style_id')::uuid <> p_style_id THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode='22023'; END IF;
  IF p_packet->>'operation' <> p_operation OR p_packet->>'model' <> p_model OR char_length(btrim(coalesce(p_packet->>'compiled_prompt',''))) NOT BETWEEN 1 AND 8000 OR p_packet->>'original_prompt' IS NULL OR jsonb_typeof(p_packet->'reference_snapshot') <> 'array' THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode='22023'; END IF;
  IF p_model LIKE 'openai/%' THEN v_provider := 'openai'; ELSIF p_model LIKE 'google/%' THEN v_provider := 'google'; ELSE RAISE EXCEPTION 'INVALID_MODEL' USING errcode='22023'; END IF;
  v_count := COALESCE((p_packet->>'count')::int, 1);
  IF v_count NOT BETWEEN 1 AND 4 OR p_packet->>'quality' NOT IN ('low','medium','high','auto') OR p_packet->>'size' NOT IN ('1024x1024','1536x1024','1024x1536','auto') THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_packet->'reference_snapshot') r WHERE jsonb_typeof(r) <> 'object' OR NOT (r ? 'id') OR (r->>'id')::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM public.style_references sr WHERE sr.id=(r->>'id')::uuid AND sr.style_id=p_style_id)) THEN RAISE EXCEPTION 'REFERENCE_NOT_FOUND' USING errcode='P0002'; END IF;
  IF p_operation IN ('image_to_image','inpaint') THEN
    v_source := (p_packet->>'source_version_id')::uuid;
    IF v_source IS NULL OR NOT EXISTS (SELECT 1 FROM public.asset_versions av JOIN public.assets a ON a.id=av.asset_id WHERE av.id=v_source AND ((a.style_id=p_style_id) OR (a.project_id IS NOT NULL AND a.project_id IN (SELECT p.id FROM public.projects p WHERE p.workspace_id=v_workspace))) ) THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND' USING errcode='P0002'; END IF;
    SELECT av.asset_id INTO v_asset FROM public.asset_versions av WHERE av.id=v_source;
  END IF;
  IF p_operation='inpaint' THEN
    IF p_mask_id IS NULL THEN RAISE EXCEPTION 'MASK_REQUIRED' USING errcode='22023'; END IF;
    SELECT * INTO v_mask FROM public.ai_job_inputs WHERE id=p_mask_id AND workspace_id=v_workspace AND style_id=p_style_id AND job_id IS NULL AND expires_at>now() FOR UPDATE;
    IF v_mask.id IS NULL OR v_mask.parent_version_id IS DISTINCT FROM v_source THEN RAISE EXCEPTION 'MASK_NOT_FOUND' USING errcode='P0002'; END IF;
    v_input := jsonb_build_object('prompt',p_packet->>'compiled_prompt','count',1,'size','auto','quality',p_packet->>'quality','style_id',p_style_id,'original_prompt',p_packet->>'original_prompt','source_version_id',v_source,'mask_id',p_mask_id,'mask_storage_path',v_mask.storage_path,'edit_target',p_packet->'edit'->>'target','reference_ids',COALESCE((SELECT jsonb_agg(r->>'id') FROM jsonb_array_elements(p_packet->'reference_snapshot') r),'[]'::jsonb));
    v_count := 1;
  ELSE
    v_input := jsonb_build_object('prompt',p_packet->>'compiled_prompt','count',v_count,'size',p_packet->>'size','quality',p_packet->>'quality','style_id',p_style_id,'original_prompt',p_packet->>'original_prompt','source_version_id',v_source,'reference_ids',COALESCE((SELECT jsonb_agg(r->>'id') FROM jsonb_array_elements(p_packet->'reference_snapshot') r),'[]'::jsonb),'cost_mode',p_packet->>'cost_mode');
  END IF;
  v_reservation := public.reserve_ai_quota_internal(v_workspace,'image',v_count);
  INSERT INTO public.ai_jobs(workspace_id,project_id,module,requested_by,operation,provider,model,status,input,style_id,style_generation,asset_id,parent_version_id)
    VALUES(v_workspace,NULL,'style',p_requested_by,p_operation,v_provider,p_model,'queued',v_input,p_style_id,p_packet,v_asset,v_source) RETURNING * INTO v_job;
  IF p_mask_id IS NOT NULL THEN UPDATE public.ai_job_inputs SET job_id=v_job.id WHERE id=p_mask_id; END IF;
  RETURN public.attach_ai_quota_reservation_internal(v_job.id,v_reservation);
END; $$;
REVOKE ALL ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid) TO authenticated;

-- Keep the cost-mode overload in sync so callers passing an explicit cost mode
-- also get source linkage (delegates to the canonical function above).
CREATE OR REPLACE FUNCTION public.enqueue_style_group_job(
  p_style_id uuid, p_requested_by uuid, p_operation text, p_model text,
  p_packet jsonb, p_mask_id uuid, p_cost_mode text
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_cost_mode IS NULL OR p_cost_mode NOT IN ('strict_style','strict_1000','balanced','quality') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode='22023'; END IF;
  RETURN public.enqueue_style_group_job(p_style_id,p_requested_by,p_operation,p_model,
    jsonb_set(p_packet,'{cost_mode}',to_jsonb(p_cost_mode),true),p_mask_id);
END; $$;
REVOKE ALL ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid,text) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid,text) TO authenticated;

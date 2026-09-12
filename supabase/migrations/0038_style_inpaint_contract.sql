-- 0038_style_inpaint_contract.sql
-- Forward contract hardening for style inpaint linkage, cost-mode JSON and
-- completion lineage. 0001-0037 remain immutable.
-- * Style operation source must belong to the style (no project same-group masquerade).
-- * Cost-mode input key is only emitted for a valid enum value (AiJobInputSchema
--   treats cost_mode as an optional enum; a json null would satisfy optional
--   and break strict parsing).
-- * Completion validates style inpaint lineage (parent belongs to source asset,
--   same style/workspace) and records server-derived provenance metadata.

-- Enqueue canonical function, tightened for style-only source linkage.
CREATE OR REPLACE FUNCTION public.enqueue_style_group_job(
  p_style_id uuid, p_requested_by uuid, p_operation text, p_model text,
  p_packet jsonb, p_mask_id uuid DEFAULT NULL
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.ai_jobs; v_workspace uuid; v_reservation uuid; v_mask public.ai_job_inputs;
  v_source uuid; v_asset uuid; v_count integer; v_provider text; v_input jsonb;
  v_ref_ids jsonb; v_cost_mode text;
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
  SELECT COALESCE(jsonb_agg(r->>'id'),'[]'::jsonb) INTO v_ref_ids FROM jsonb_array_elements(p_packet->'reference_snapshot') r;
  IF p_operation IN ('image_to_image','inpaint') THEN
    v_source := (p_packet->>'source_version_id')::uuid;
    -- Style source must belong to this style group; never accept a same-group project masquerade.
    IF v_source IS NULL OR NOT EXISTS (SELECT 1 FROM public.asset_versions av JOIN public.assets a ON a.id=av.asset_id WHERE av.id=v_source AND a.style_id=p_style_id) THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND' USING errcode='P0002'; END IF;
    SELECT av.asset_id INTO v_asset FROM public.asset_versions av WHERE av.id=v_source;
  END IF;
  IF p_operation='inpaint' THEN
    IF p_mask_id IS NULL THEN RAISE EXCEPTION 'MASK_REQUIRED' USING errcode='22023'; END IF;
    SELECT * INTO v_mask FROM public.ai_job_inputs WHERE id=p_mask_id AND workspace_id=v_workspace AND style_id=p_style_id AND job_id IS NULL AND expires_at>now() FOR UPDATE;
    IF v_mask.id IS NULL OR v_mask.parent_version_id IS DISTINCT FROM v_source THEN RAISE EXCEPTION 'MASK_NOT_FOUND' USING errcode='P0002'; END IF;
    v_input := jsonb_build_object('prompt',p_packet->>'compiled_prompt','count',1,'size','auto','quality',p_packet->>'quality','style_id',p_style_id,'original_prompt',p_packet->>'original_prompt','source_version_id',v_source,'mask_id',p_mask_id,'mask_storage_path',v_mask.storage_path,'edit_target',p_packet->'edit'->>'target','reference_ids',v_ref_ids);
    v_count := 1;
  ELSE
    -- cost_mode is an optional enum in AiJobInputSchema: omit the key unless a
    -- valid enum value is present, never emit json null.
    v_cost_mode := p_packet->>'cost_mode';
    IF v_cost_mode IS NOT NULL AND v_cost_mode NOT IN ('strict_style','strict_1000','balanced','quality') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode='22023'; END IF;
    v_input := jsonb_build_object('prompt',p_packet->>'compiled_prompt','count',v_count,'size',p_packet->>'size','quality',p_packet->>'quality','style_id',p_style_id,'original_prompt',p_packet->>'original_prompt','source_version_id',v_source,'reference_ids',v_ref_ids)
      || CASE WHEN v_cost_mode IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cost_mode',v_cost_mode) END;
  END IF;
  v_reservation := public.reserve_ai_quota_internal(v_workspace,'image',v_count);
  INSERT INTO public.ai_jobs(workspace_id,project_id,module,requested_by,operation,provider,model,status,input,style_id,style_generation,asset_id,parent_version_id)
    VALUES(v_workspace,NULL,'style',p_requested_by,p_operation,v_provider,p_model,'queued',v_input,p_style_id,p_packet,v_asset,v_source) RETURNING * INTO v_job;
  IF p_mask_id IS NOT NULL THEN UPDATE public.ai_job_inputs SET job_id=v_job.id WHERE id=p_mask_id; END IF;
  RETURN public.attach_ai_quota_reservation_internal(v_job.id,v_reservation);
END; $$;
REVOKE ALL ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid) TO authenticated;

-- Keep the cost-mode overload in sync (delegates to the canonical function above).
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

-- Completion: style inpaint lineage validation and server-derived provenance,
-- appended after provider metadata so provider metadata never overwrites it.
CREATE OR REPLACE FUNCTION public.complete_ai_job_with_results(
  p_job_id uuid, p_worker_id text, p_provider_request_id text, p_provider_status text,
  p_results jsonb, p_output jsonb
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j public.ai_jobs; r jsonb; a uuid; v uuid; n integer := 0; expected integer; is_style boolean;
  v_meta jsonb; v_lineage jsonb;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode='42501'; END IF;
  j := public.assert_ai_job_lease(p_job_id,p_worker_id);
  IF j.status <> 'persisting' OR jsonb_typeof(p_results) <> 'array' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode='22023'; END IF;
  is_style := j.module='style'; expected := CASE WHEN j.operation='inpaint' AND NOT is_style THEN 1 ELSE COALESCE((j.input->>'count')::integer,0) END;
  IF expected < 1 OR jsonb_array_length(p_results) <> expected THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode='22023'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_results) LOOP
    IF jsonb_typeof(r)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(r))<>11 OR NOT (r ?& array['asset_id','version_id','storage_path','mime_type','width','height','byte_size','name','prompt','provider_response_id','metadata']) THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode='22023'; END IF;
    IF r->>'mime_type' NOT IN ('image/png','image/jpeg','image/webp') OR (r->>'width')::integer<=0 OR (r->>'height')::integer<=0 OR (r->>'byte_size')::bigint<=0 OR (r->>'byte_size')::bigint>52428800 OR jsonb_typeof(r->'metadata')<>'object' THEN RAISE EXCEPTION 'UNSUPPORTED_IMAGE' USING errcode='22023'; END IF;
    a := (r->>'asset_id')::uuid; v := (r->>'version_id')::uuid;
    IF is_style THEN
      IF j.style_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.styles WHERE id=j.style_id AND workspace_id=j.workspace_id AND status='active') THEN RAISE EXCEPTION 'STYLE_NOT_ACTIVE' USING errcode='P0002'; END IF;
      -- Style lineage: result asset must be new; parent inpaint belongs to the
      -- recorded source asset and same style/workspace; variation parent from
      -- input.source_version_id same style.
      IF EXISTS (SELECT 1 FROM public.assets WHERE id=a) THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode='23000'; END IF;
      IF j.operation IN ('inpaint','image_to_image') THEN
        DECLARE p_parent uuid; p_asset uuid;
        BEGIN
          p_parent := CASE WHEN j.operation='inpaint' THEN j.parent_version_id ELSE (j.input->>'source_version_id')::uuid END;
          IF p_parent IS NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode='23000'; END IF;
          IF NOT EXISTS (SELECT 1 FROM public.asset_versions vv JOIN public.assets aa ON aa.id=vv.asset_id JOIN public.styles st ON st.id=aa.style_id WHERE vv.id=p_parent AND aa.id=j.asset_id AND st.workspace_id=j.workspace_id) THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode='23000'; END IF;
        END;
      END IF;
      v_meta := CASE WHEN jsonb_typeof(r->'metadata')='object' THEN r->'metadata' ELSE '{}'::jsonb END;
      v_lineage := jsonb_build_object('source_asset_id',j.asset_id,'source_version_id',COALESCE(j.parent_version_id,(j.input->>'source_version_id')::uuid));
      INSERT INTO public.assets(id,style_id,name,kind) VALUES(a,j.style_id,coalesce(nullif(btrim(r->>'name'),''),'Untitled'),'generated');
      INSERT INTO public.asset_versions(id,asset_id,parent_version_id,source,storage_path,mime_type,width,height,byte_size,prompt,provider_response_id,metadata,style_generation)
        VALUES(v,a,CASE WHEN j.operation='inpaint' THEN j.parent_version_id WHEN j.operation='image_to_image' THEN (j.input->>'source_version_id')::uuid ELSE NULL END,'web_openai',r->>'storage_path',r->>'mime_type',(r->>'width')::integer,(r->>'height')::integer,(r->>'byte_size')::bigint,r->>'prompt',r->>'provider_response_id',v_meta||v_lineage,j.style_generation);
      UPDATE public.assets SET current_version_id=v,updated_at=now() WHERE id=a;
    ELSIF j.operation='inpaint' THEN
      IF n>0 OR a<>j.asset_id OR NOT EXISTS (SELECT 1 FROM public.asset_versions WHERE id=j.parent_version_id AND asset_id=a) THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode='23000'; END IF;
      INSERT INTO public.asset_versions(id,asset_id,parent_version_id,source,storage_path,mime_type,width,height,byte_size,prompt,provider_response_id,metadata)
        VALUES(v,a,j.parent_version_id,'web_openai',r->>'storage_path',r->>'mime_type',(r->>'width')::integer,(r->>'height')::integer,(r->>'byte_size')::bigint,r->>'prompt',r->>'provider_response_id',r->'metadata');
      UPDATE public.assets SET current_version_id=v,name=coalesce(nullif(btrim(r->>'name'),''),name),updated_at=now() WHERE id=a;
    ELSE
      IF j.project_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.projects WHERE id=j.project_id AND workspace_id=j.workspace_id) THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode='P0002'; END IF;
      INSERT INTO public.assets(id,project_id,name,kind) VALUES(a,j.project_id,coalesce(nullif(btrim(r->>'name'),''),'Untitled'),'generated');
      INSERT INTO public.asset_versions(id,asset_id,source,storage_path,mime_type,width,height,byte_size,prompt,provider_response_id,metadata)
        VALUES(v,a,'web_openai',r->>'storage_path',r->>'mime_type',(r->>'width')::integer,(r->>'height')::integer,(r->>'byte_size')::bigint,r->>'prompt',r->>'provider_response_id',r->'metadata');
      UPDATE public.assets SET current_version_id=v,updated_at=now() WHERE id=a;
    END IF;
    n := n+1;
  END LOOP;
  UPDATE public.ai_jobs SET status='succeeded',asset_id=(p_results->0->>'asset_id')::uuid,version_id=(p_results->0->>'version_id')::uuid,provider_request_id=p_provider_request_id,provider_status=p_provider_status,output=coalesce(p_output,'{}'::jsonb),lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,error_message=NULL,completed_at=now(),updated_at=now() WHERE id=p_job_id RETURNING * INTO j;
  RETURN j;
END; $$;
REVOKE ALL ON FUNCTION public.complete_ai_job_with_results(uuid,text,text,text,jsonb,jsonb) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_ai_job_with_results(uuid,text,text,text,jsonb,jsonb) TO service_role;

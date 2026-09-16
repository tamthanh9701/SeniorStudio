-- 0044_reference_capacity_20.sql
-- A style may hold 20 references, and a job sends only the ones the chosen model
-- accepts. add_style_reference still counts live rows; the enqueue function now
-- accepts an ordered subset of the confirmed snapshot instead of demanding the
-- whole set, so "16 of 20" is a legal packet. 0001-0043 remain immutable.

-- The definition guard also pinned the snapshot to 8 references; a 20-image
-- style could otherwise never be confirmed (INVALID_CONFIRMED_DEFINITION).
CREATE OR REPLACE FUNCTION public.guard_style_definition_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.confirmed_definition IS DISTINCT FROM OLD.confirmed_definition
     AND coalesce(current_setting('app.style_definition_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'CONFIRMED_DEFINITION_PROTECTED' USING errcode = '42501';
  END IF;
  IF NEW.confirmed_definition IS NOT NULL
     AND (jsonb_typeof(NEW.confirmed_definition) <> 'object'
          OR (NEW.confirmed_definition->>'definition_version')::int <> 1
          OR jsonb_typeof(NEW.confirmed_definition->'schema_snapshot') <> 'object'
          OR jsonb_typeof(NEW.confirmed_definition->'reference_snapshot') <> 'array'
          OR jsonb_array_length(NEW.confirmed_definition->'reference_snapshot') NOT BETWEEN 1 AND 20) THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.add_style_reference(p_style_id uuid, p_reference jsonb)
RETURNS public.style_references LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_workspace uuid; v_reference public.style_references; v_live integer;
  v_width integer; v_height integer; v_id uuid; v_path text; v_mime text; v_ext text;
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT workspace_id INTO v_workspace FROM public.styles
    WHERE id = p_style_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF v_workspace IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_reference IS NULL OR jsonb_typeof(p_reference) <> 'object' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;

  -- Id and object name are one identity; the worker relies on it.
  IF coalesce(p_reference->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  v_id := (p_reference->>'id')::uuid;
  v_path := coalesce(p_reference->>'storage_path','');
  v_mime := coalesce(p_reference->>'mime_type','');
  IF v_path NOT IN (
    v_workspace::text || '/styles/' || p_style_id::text || '/' || v_id::text || '.png',
    v_workspace::text || '/styles/' || p_style_id::text || '/' || v_id::text || '.jpg',
    v_workspace::text || '/styles/' || p_style_id::text || '/' || v_id::text || '.jpeg'
  ) THEN RAISE EXCEPTION 'INVALID_STORAGE_PATH' USING errcode = '22023'; END IF;
  v_ext := lower(split_part(v_path, '.', -1));
  IF v_mime NOT IN ('image/png','image/jpeg') THEN RAISE EXCEPTION 'UNSUPPORTED_IMAGE_TYPE' USING errcode = '22023'; END IF;
  IF (v_mime = 'image/png') <> (v_ext = 'png') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  IF coalesce((p_reference->>'byte_size')::bigint, 0) NOT BETWEEN 1 AND 5242880 THEN RAISE EXCEPTION 'REFERENCE_TOO_LARGE' USING errcode = '22023'; END IF;
  IF coalesce(p_reference->>'content_hash','') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;

  SELECT count(*) INTO v_live FROM public.style_references WHERE style_id = p_style_id AND retired_at IS NULL;
  IF v_live >= 20 THEN RAISE EXCEPTION 'TOO_MANY_REFERENCES' USING errcode = '22023'; END IF;
  v_width := nullif(p_reference->>'width','')::integer;
  v_height := nullif(p_reference->>'height','')::integer;
  INSERT INTO public.style_references(id, style_id, storage_path, mime_type, byte_size, width, height, content_hash)
    VALUES (v_id, p_style_id, v_path, v_mime, (p_reference->>'byte_size')::bigint, v_width, v_height, p_reference->>'content_hash')
    RETURNING * INTO v_reference;
  UPDATE public.styles SET updated_at = now() WHERE id = p_style_id;
  RETURN v_reference;
END; $$;
REVOKE ALL ON FUNCTION public.add_style_reference(uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.add_style_reference(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.enqueue_style_group_job(
  p_style_id uuid, p_requested_by uuid, p_operation text, p_model text,
  p_packet jsonb, p_mask_id uuid DEFAULT NULL
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.ai_jobs; v_workspace uuid; v_reservation uuid; v_mask public.ai_job_inputs;
  v_source uuid; v_asset uuid; v_count integer; v_provider text; v_input jsonb;
  v_ref_ids jsonb; v_cost_mode text; v_style public.styles; v_authority jsonb;
  v_snapshot jsonb; v_fallback boolean; v_packet_refs jsonb;
BEGIN
  IF auth.role() <> 'authenticated' OR auth.uid() <> p_requested_by THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT * INTO v_style FROM public.styles WHERE id = p_style_id AND workspace_id IN (SELECT public.current_workspace_ids());
  IF v_style.id IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_operation NOT IN ('text_to_image','image_to_image','inpaint') OR p_packet IS NULL OR jsonb_typeof(p_packet) <> 'object' OR (p_packet->>'packet_version')::int <> 1 OR (p_packet->>'style_id')::uuid <> p_style_id THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
  IF p_packet->>'operation' <> p_operation OR p_packet->>'model' <> p_model OR char_length(btrim(coalesce(p_packet->>'compiled_prompt',''))) NOT BETWEEN 1 AND 8000 OR p_packet->>'original_prompt' IS NULL OR jsonb_typeof(p_packet->'reference_snapshot') <> 'array' OR jsonb_typeof(p_packet->'schema_snapshot') <> 'object' THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
  IF p_model LIKE 'openai/%' THEN v_provider := 'openai'; ELSIF p_model LIKE 'google/%' THEN v_provider := 'google'; ELSE RAISE EXCEPTION 'INVALID_MODEL' USING errcode = '22023'; END IF;
  v_count := COALESCE((p_packet->>'count')::int, 1);
  IF v_count NOT BETWEEN 1 AND 4 OR p_packet->>'quality' NOT IN ('low','medium','high','auto') OR p_packet->>'size' NOT IN ('1024x1024','1536x1024','1024x1536','auto') THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
  v_fallback := coalesce(p_packet->'metadata'->>'style_provenance','') = 'current_style_fallback';

  IF p_operation = 'inpaint' THEN
    v_source := (p_packet->>'source_version_id')::uuid;
    -- Style source must belong to this style group; never accept a same-group project masquerade.
    IF v_source IS NULL OR NOT EXISTS (SELECT 1 FROM public.asset_versions av JOIN public.assets a ON a.id = av.asset_id WHERE av.id = v_source AND a.style_id = p_style_id) THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND' USING errcode = 'P0002'; END IF;
    SELECT av.asset_id, av.style_generation INTO v_asset, v_authority FROM public.asset_versions av WHERE av.id = v_source;
    IF v_fallback OR v_authority IS NULL OR jsonb_typeof(v_authority->'reference_snapshot') <> 'array' OR jsonb_array_length(v_authority->'reference_snapshot') = 0 THEN
      -- Legacy source without a usable original definition: adoption of the
      -- confirmed style must be explicit, never silent.
      IF NOT v_fallback THEN RAISE EXCEPTION 'STYLE_SOURCE_SNAPSHOT_REQUIRED' USING errcode = 'P0002'; END IF;
      IF v_style.status <> 'active' OR jsonb_typeof(v_style.confirmed_definition) <> 'object' THEN RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;
      v_authority := v_style.confirmed_definition;
    END IF;
  ELSE
    IF v_fallback THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
    IF v_style.status <> 'active' OR jsonb_typeof(v_style.confirmed_definition) <> 'object' THEN RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;
    v_authority := v_style.confirmed_definition;
    IF p_operation = 'image_to_image' THEN
      -- A variation is generated from one recorded version of this style; the
      -- worker downloads it and completion records it as the parent.
      v_source := (p_packet->>'source_version_id')::uuid;
      IF v_source IS NULL OR NOT EXISTS (SELECT 1 FROM public.asset_versions av JOIN public.assets a ON a.id = av.asset_id WHERE av.id = v_source AND a.style_id = p_style_id) THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND' USING errcode = 'P0002'; END IF;
      SELECT av.asset_id INTO v_asset FROM public.asset_versions av WHERE av.id = v_source;
    END IF;
  END IF;

  -- The packet must describe exactly the authoritative definition.
  IF v_authority->'schema_snapshot' IS DISTINCT FROM p_packet->'schema_snapshot' THEN RAISE EXCEPTION 'STYLE_CONFLICT' USING errcode = '23000'; END IF;
  IF coalesce(v_authority->>'style_revision','') <> coalesce(p_packet->>'style_revision','') THEN RAISE EXCEPTION 'STYLE_CONFLICT' USING errcode = '23000'; END IF;
  v_snapshot := coalesce(v_authority->'reference_snapshot','[]'::jsonb);
  IF jsonb_typeof(v_snapshot) <> 'array' OR jsonb_array_length(v_snapshot) NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;
  -- The packet carries an ordered subset of the confirmed snapshot: a model
  -- accepts fewer input images than the style may hold, and the plan drops the
  -- tail. Anything outside the snapshot is still rejected.
  v_packet_refs := coalesce(p_packet->'reference_snapshot','[]'::jsonb);
  IF jsonb_array_length(v_packet_refs) NOT BETWEEN 1 AND jsonb_array_length(v_snapshot) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_packet_refs) r
       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_snapshot) s
         WHERE s->>'id' = r->>'id' AND coalesce(s->>'content_hash','') = coalesce(r->>'content_hash',''))
     ) THEN RAISE EXCEPTION 'REFERENCE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  -- Equal lengths used to make duplicates impossible; the subset rule needs its own guard.
  IF (SELECT count(DISTINCT r->>'id') FROM jsonb_array_elements(v_packet_refs) r) <> jsonb_array_length(v_packet_refs) THEN
    RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
  -- Rows must still exist for the style with the recorded hash; retired rows are
  -- valid here because an authorized snapshot is resolving them.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_snapshot) s
       WHERE NOT EXISTS (SELECT 1 FROM public.style_references sr
         WHERE sr.id = (s->>'id')::uuid AND sr.style_id = p_style_id
           AND coalesce(sr.content_hash,'') = coalesce(s->>'content_hash',''))) THEN
    RAISE EXCEPTION 'REFERENCE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT coalesce(jsonb_agg(r->>'id'), '[]'::jsonb) INTO v_ref_ids FROM jsonb_array_elements(v_packet_refs) r;

  IF p_operation = 'inpaint' THEN
    IF p_mask_id IS NULL THEN RAISE EXCEPTION 'MASK_REQUIRED' USING errcode = '22023'; END IF;
    SELECT * INTO v_mask FROM public.ai_job_inputs WHERE id = p_mask_id AND workspace_id = v_style.workspace_id AND style_id = p_style_id AND job_id IS NULL AND expires_at > now() FOR UPDATE;
    IF v_mask.id IS NULL OR v_mask.parent_version_id IS DISTINCT FROM v_source THEN RAISE EXCEPTION 'MASK_NOT_FOUND' USING errcode = 'P0002'; END IF;
    v_input := jsonb_build_object('prompt',p_packet->>'compiled_prompt','count',1,'size','auto','quality',p_packet->>'quality','style_id',p_style_id,'original_prompt',p_packet->>'original_prompt','source_version_id',v_source,'mask_id',p_mask_id,'mask_storage_path',v_mask.storage_path,'edit_target',p_packet->'edit'->>'target','reference_ids',v_ref_ids);
    v_count := 1;
  ELSE
    -- cost_mode is an optional enum in AiJobInputSchema: omit the key unless a
    -- valid enum value is present, never emit json null.
    v_cost_mode := p_packet->>'cost_mode';
    IF v_cost_mode IS NOT NULL AND v_cost_mode NOT IN ('strict_style','strict_1000','balanced','quality') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    v_input := jsonb_build_object('prompt',p_packet->>'compiled_prompt','count',v_count,'size',p_packet->>'size','quality',p_packet->>'quality','style_id',p_style_id,'original_prompt',p_packet->>'original_prompt','source_version_id',v_source,'reference_ids',v_ref_ids)
      || CASE WHEN v_cost_mode IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cost_mode',v_cost_mode) END;
  END IF;
  v_workspace := v_style.workspace_id;
  v_reservation := public.reserve_ai_quota_internal(v_workspace,'image',v_count);
  INSERT INTO public.ai_jobs(workspace_id,project_id,module,requested_by,operation,provider,model,status,input,style_id,style_generation,asset_id,parent_version_id,source_version_id)
    VALUES(v_workspace,NULL,'style',p_requested_by,p_operation,v_provider,p_model,'queued',v_input,p_style_id,p_packet,v_asset,v_source,v_source) RETURNING * INTO v_job;
  IF p_mask_id IS NOT NULL THEN UPDATE public.ai_job_inputs SET job_id = v_job.id WHERE id = p_mask_id; END IF;
  RETURN public.attach_ai_quota_reservation_internal(v_job.id, v_reservation);
END; $$;
REVOKE ALL ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid) TO authenticated;

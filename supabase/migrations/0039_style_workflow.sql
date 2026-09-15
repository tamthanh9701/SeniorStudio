-- 0039_style_workflow.sql
-- Style-first workflow contract: confirmed definitions, reference retirement,
-- source-authoritative inpaint, same-asset candidate edits and CAS selection.
-- 0001-0038 remain immutable.

-- ---------------------------------------------------------------------------
-- 1. Durable confirmed definition and reference retirement
-- ---------------------------------------------------------------------------

-- Confirmed definition is the only authority for new generation.  The mutable
-- candidate columns (schema/fingerprint/invariant_contract/analysis_meta) keep
-- serving review and editing.
ALTER TABLE public.styles ADD COLUMN IF NOT EXISTS confirmed_definition jsonb;

-- Retired references keep their row and bytes so already-confirmed snapshots and
-- historical source packets stay resolvable.  They leave the editable set only.
ALTER TABLE public.style_references ADD COLUMN IF NOT EXISTS retired_at timestamptz;
CREATE INDEX IF NOT EXISTS style_references_live_idx ON public.style_references(style_id) WHERE retired_at IS NULL;

-- Only the definition-confirming RPC may write confirmed_definition.  A
-- transaction-local flag is used because security-definer functions still
-- report the caller's JWT role through auth.role().
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
          OR jsonb_array_length(NEW.confirmed_definition->'reference_snapshot') NOT BETWEEN 1 AND 8) THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS styles_guard_definition_trigger ON public.styles;
CREATE TRIGGER styles_guard_definition_trigger BEFORE UPDATE ON public.styles
FOR EACH ROW EXECUTE FUNCTION public.guard_style_definition_write();

-- Reference rows are mutated only through the owner-checked RPCs below.
DROP POLICY IF EXISTS "Users can manage style references in their workspace" ON public.style_references;
DROP POLICY IF EXISTS "Users can read style references in their workspace" ON public.style_references;
CREATE POLICY "Users can read style references in their workspace" ON public.style_references
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.styles s WHERE s.id = style_id
    AND s.workspace_id IN (SELECT public.current_workspace_ids())));

-- ---------------------------------------------------------------------------
-- 2. Reference add/retire RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.add_style_reference(p_style_id uuid, p_reference jsonb)
RETURNS public.style_references LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_workspace uuid; v_reference public.style_references; v_live integer; v_width integer; v_height integer;
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT workspace_id INTO v_workspace FROM public.styles
    WHERE id = p_style_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF v_workspace IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_reference IS NULL OR jsonb_typeof(p_reference) <> 'object' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  IF coalesce(p_reference->>'storage_path','') NOT LIKE v_workspace::text || '/styles/' || p_style_id::text || '/%' THEN
    RAISE EXCEPTION 'INVALID_STORAGE_PATH' USING errcode = '22023'; END IF;
  IF (p_reference->>'mime_type') NOT IN ('image/png','image/jpeg') THEN RAISE EXCEPTION 'UNSUPPORTED_IMAGE_TYPE' USING errcode = '22023'; END IF;
  IF coalesce((p_reference->>'byte_size')::bigint, 0) NOT BETWEEN 1 AND 5242880 THEN RAISE EXCEPTION 'REFERENCE_TOO_LARGE' USING errcode = '22023'; END IF;
  IF coalesce(p_reference->>'content_hash','') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  SELECT count(*) INTO v_live FROM public.style_references WHERE style_id = p_style_id AND retired_at IS NULL;
  IF v_live >= 8 THEN RAISE EXCEPTION 'TOO_MANY_REFERENCES' USING errcode = '22023'; END IF;
  v_width := nullif(p_reference->>'width','')::integer;
  v_height := nullif(p_reference->>'height','')::integer;
  INSERT INTO public.style_references(style_id, storage_path, mime_type, byte_size, width, height, content_hash)
    VALUES (p_style_id, p_reference->>'storage_path', p_reference->>'mime_type',
            (p_reference->>'byte_size')::bigint, v_width, v_height, p_reference->>'content_hash')
    RETURNING * INTO v_reference;
  UPDATE public.styles SET updated_at = now() WHERE id = p_style_id;
  RETURN v_reference;
END; $$;
REVOKE ALL ON FUNCTION public.add_style_reference(uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.add_style_reference(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.retire_style_reference(p_style_id uuid, p_reference_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_workspace uuid;
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT workspace_id INTO v_workspace FROM public.styles
    WHERE id = p_style_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF v_workspace IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.style_references WHERE id = p_reference_id AND style_id = p_style_id) THEN
    RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  -- Idempotent: retiring an already retired reference succeeds.
  UPDATE public.style_references SET retired_at = coalesce(retired_at, now())
    WHERE id = p_reference_id AND style_id = p_style_id;
  UPDATE public.styles SET updated_at = now() WHERE id = p_style_id;
END; $$;
REVOKE ALL ON FUNCTION public.retire_style_reference(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.retire_style_reference(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Confirm the analysed candidate into an immutable definition
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.confirm_style_definition(p_style_id uuid, p_expected_updated_at timestamptz)
RETURNS public.styles LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_style public.styles; v_live jsonb; v_snapshot jsonb; v_meta jsonb; v_grade text;
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT * INTO v_style FROM public.styles
    WHERE id = p_style_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF v_style.id IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_expected_updated_at IS NULL OR v_style.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'STYLE_VERSION_CONFLICT' USING errcode = '23000'; END IF;

  -- Candidate must be a complete, analysed schema.  Direct RPC callers cannot
  -- confirm empty or partially written data.
  IF jsonb_typeof(v_style.schema) <> 'object'
     OR NOT (v_style.schema ?& array['style_name','version','subject_type','subject','environment','composition','lighting','color_palette','artistic_style','mood_atmosphere','material_texture','technical_quality','camera_lens','post_processing','negative_prompt','generation_params'])
     OR jsonb_typeof(v_style.fingerprint) <> 'object'
     OR jsonb_typeof(v_style.invariant_contract) <> 'object' THEN
    RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;
  v_meta := coalesce(v_style.analysis_meta, '{}'::jsonb);
  IF v_meta->>'analyzedAt' IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;
  v_grade := v_style.operability->>'grade';
  IF v_grade NOT IN ('production_ready','usable_with_warnings') THEN
    RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'content_hash', r.content_hash) ORDER BY r.created_at, r.id), '[]'::jsonb)
    INTO v_live FROM public.style_references r WHERE r.style_id = p_style_id AND r.retired_at IS NULL;
  IF jsonb_array_length(v_live) < 1 THEN RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_live) e WHERE coalesce(e->>'content_hash','') !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;

  -- The analysed reference set must still be the live one; anything else is stale.
  v_snapshot := v_meta->'reference_snapshot';
  IF jsonb_typeof(v_snapshot) <> 'array'
     OR jsonb_array_length(v_snapshot) <> jsonb_array_length(v_live)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_snapshot) s
       WHERE NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_live) l
         WHERE l->>'id' = s->>'id' AND coalesce(l->>'content_hash','') = coalesce(s->>'content_hash','')
       )
     ) THEN
    RAISE EXCEPTION 'STYLE_ANALYSIS_STALE' USING errcode = '23000'; END IF;

  PERFORM set_config('app.style_definition_write', 'on', true);
  UPDATE public.styles
    SET confirmed_definition = jsonb_build_object(
          'definition_version', 1,
          'style_revision', gen_random_uuid(),
          'schema_snapshot', v_style.schema,
          'reference_snapshot', v_live,
          'confirmed_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
        status = 'active',
        updated_at = now()
    WHERE id = p_style_id
    RETURNING * INTO v_style;
  RETURN v_style;
END; $$;
REVOKE ALL ON FUNCTION public.confirm_style_definition(uuid, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.confirm_style_definition(uuid, timestamptz) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Compare-and-swap current version selection
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.select_asset_version(p_asset_id uuid, p_version_id uuid, p_expected_current_version_id uuid)
RETURNS public.assets LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_asset public.assets;
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT * INTO v_asset FROM public.assets a
    WHERE a.id = p_asset_id AND (
      (a.style_id IS NOT NULL AND a.style_id IN (SELECT s.id FROM public.styles s WHERE s.workspace_id IN (SELECT public.current_workspace_ids())))
      OR (a.project_id IS NOT NULL AND a.project_id IN (SELECT p.id FROM public.projects p WHERE p.workspace_id IN (SELECT public.current_workspace_ids())))
    ) FOR UPDATE;
  IF v_asset.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.asset_versions WHERE id = p_version_id AND asset_id = p_asset_id) THEN
    RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  -- Selecting the version that is already current is a success, not a conflict.
  IF v_asset.current_version_id IS NOT DISTINCT FROM p_version_id THEN RETURN v_asset; END IF;
  IF v_asset.current_version_id IS DISTINCT FROM p_expected_current_version_id THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
  UPDATE public.assets SET current_version_id = p_version_id, updated_at = now()
    WHERE id = p_asset_id RETURNING * INTO v_asset;
  RETURN v_asset;
END; $$;
REVOKE ALL ON FUNCTION public.select_asset_version(uuid, uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.select_asset_version(uuid, uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Enqueue: confirmed definition / source packet is the only authority
-- ---------------------------------------------------------------------------

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
  END IF;

  -- The packet must describe exactly the authoritative definition.
  IF v_authority->'schema_snapshot' IS DISTINCT FROM p_packet->'schema_snapshot' THEN RAISE EXCEPTION 'STYLE_CONFLICT' USING errcode = '23000'; END IF;
  IF coalesce(v_authority->>'style_revision','') <> coalesce(p_packet->>'style_revision','') THEN RAISE EXCEPTION 'STYLE_CONFLICT' USING errcode = '23000'; END IF;
  v_snapshot := coalesce(v_authority->'reference_snapshot','[]'::jsonb);
  IF jsonb_typeof(v_snapshot) <> 'array' OR jsonb_array_length(v_snapshot) NOT BETWEEN 1 AND 8 THEN RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;
  v_packet_refs := coalesce(p_packet->'reference_snapshot','[]'::jsonb);
  IF jsonb_array_length(v_packet_refs) <> jsonb_array_length(v_snapshot) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_packet_refs) r
       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_snapshot) s
         WHERE s->>'id' = r->>'id' AND coalesce(s->>'content_hash','') = coalesce(r->>'content_hash',''))
     ) THEN RAISE EXCEPTION 'REFERENCE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  -- Rows must still exist for the style with the recorded hash; retired rows are
  -- valid here because an authorized snapshot is resolving them.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_snapshot) s
       WHERE NOT EXISTS (SELECT 1 FROM public.style_references sr
         WHERE sr.id = (s->>'id')::uuid AND sr.style_id = p_style_id
           AND coalesce(sr.content_hash,'') = coalesce(s->>'content_hash',''))) THEN
    RAISE EXCEPTION 'REFERENCE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT coalesce(jsonb_agg(s->>'id'), '[]'::jsonb) INTO v_ref_ids FROM jsonb_array_elements(v_snapshot) s;

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
  INSERT INTO public.ai_jobs(workspace_id,project_id,module,requested_by,operation,provider,model,status,input,style_id,style_generation,asset_id,parent_version_id)
    VALUES(v_workspace,NULL,'style',p_requested_by,p_operation,v_provider,p_model,'queued',v_input,p_style_id,p_packet,v_asset,v_source) RETURNING * INTO v_job;
  IF p_mask_id IS NOT NULL THEN UPDATE public.ai_job_inputs SET job_id = v_job.id WHERE id = p_mask_id; END IF;
  RETURN public.attach_ai_quota_reservation_internal(v_job.id, v_reservation);
END; $$;
REVOKE ALL ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid) TO authenticated;

-- Keep the cost-mode overload in sync (delegates to the canonical function above).
CREATE OR REPLACE FUNCTION public.enqueue_style_group_job(
  p_style_id uuid, p_requested_by uuid, p_operation text, p_model text,
  p_packet jsonb, p_mask_id uuid, p_cost_mode text
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_cost_mode IS NULL OR p_cost_mode NOT IN ('strict_style','strict_1000','balanced','quality') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  RETURN public.enqueue_style_group_job(p_style_id,p_requested_by,p_operation,p_model,
    jsonb_set(p_packet,'{cost_mode}',to_jsonb(p_cost_mode),true),p_mask_id);
END; $$;
REVOKE ALL ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid,text) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid,text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Completion: candidate child version for style inpaint
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_ai_job_with_results(
  p_job_id uuid, p_worker_id text, p_provider_request_id text, p_provider_status text,
  p_results jsonb, p_output jsonb
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j public.ai_jobs; r jsonb; a uuid; v uuid; n integer := 0; expected integer; is_style boolean;
  v_meta jsonb; v_lineage jsonb;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501'; END IF;
  j := public.assert_ai_job_lease(p_job_id, p_worker_id);
  IF j.status <> 'persisting' OR jsonb_typeof(p_results) <> 'array' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  is_style := j.module = 'style';
  expected := CASE WHEN j.operation = 'inpaint' THEN 1 ELSE COALESCE((j.input->>'count')::integer, 0) END;
  IF expected < 1 OR jsonb_array_length(p_results) <> expected THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_results) LOOP
    IF jsonb_typeof(r) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(r)) <> 11 OR NOT (r ?& array['asset_id','version_id','storage_path','mime_type','width','height','byte_size','name','prompt','provider_response_id','metadata']) THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    IF r->>'mime_type' NOT IN ('image/png','image/jpeg','image/webp') OR (r->>'width')::integer <= 0 OR (r->>'height')::integer <= 0 OR (r->>'byte_size')::bigint <= 0 OR (r->>'byte_size')::bigint > 52428800 OR jsonb_typeof(r->'metadata') <> 'object' THEN RAISE EXCEPTION 'UNSUPPORTED_IMAGE' USING errcode = '22023'; END IF;
    a := (r->>'asset_id')::uuid; v := (r->>'version_id')::uuid;
    IF is_style THEN
      -- An already authorized job only needs its style to still exist; a style
      -- that was edited after enqueue must not invalidate the recorded lineage.
      IF j.style_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.styles WHERE id = j.style_id AND workspace_id = j.workspace_id) THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
      v_meta := CASE WHEN jsonb_typeof(r->'metadata') = 'object' THEN r->'metadata' ELSE '{}'::jsonb END;
      IF j.operation = 'inpaint' THEN
        -- Candidate edit: a child version of the recorded source asset.  The
        -- current version moves only when the user keeps the edit.
        IF j.asset_id IS NULL OR a <> j.asset_id OR j.parent_version_id IS NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
        IF NOT EXISTS (SELECT 1 FROM public.asset_versions vv JOIN public.assets aa ON aa.id = vv.asset_id JOIN public.styles st ON st.id = aa.style_id
                       WHERE vv.id = j.parent_version_id AND aa.id = j.asset_id AND aa.style_id = j.style_id AND st.workspace_id = j.workspace_id) THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
        IF EXISTS (SELECT 1 FROM public.asset_versions WHERE id = v) THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
        v_lineage := jsonb_build_object('source_asset_id',j.asset_id,'source_version_id',j.parent_version_id);
        INSERT INTO public.asset_versions(id,asset_id,parent_version_id,source,storage_path,mime_type,width,height,byte_size,prompt,provider_response_id,metadata,style_generation)
          VALUES(v,a,j.parent_version_id,'web_openai',r->>'storage_path',r->>'mime_type',(r->>'width')::integer,(r->>'height')::integer,(r->>'byte_size')::bigint,r->>'prompt',r->>'provider_response_id',v_meta||v_lineage,j.style_generation);
      ELSE
        IF EXISTS (SELECT 1 FROM public.assets WHERE id = a) THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
        IF j.operation = 'image_to_image' THEN
          IF j.parent_version_id IS NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
          IF NOT EXISTS (SELECT 1 FROM public.asset_versions vv JOIN public.assets aa ON aa.id = vv.asset_id JOIN public.styles st ON st.id = aa.style_id
                         WHERE vv.id = j.parent_version_id AND aa.id = j.asset_id AND aa.style_id = j.style_id AND st.workspace_id = j.workspace_id) THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
        END IF;
        v_lineage := jsonb_build_object('source_asset_id',j.asset_id,'source_version_id',COALESCE(j.parent_version_id,(j.input->>'source_version_id')::uuid));
        INSERT INTO public.assets(id,style_id,name,kind) VALUES(a,j.style_id,coalesce(nullif(btrim(r->>'name'),''),'Untitled'),'generated');
        INSERT INTO public.asset_versions(id,asset_id,parent_version_id,source,storage_path,mime_type,width,height,byte_size,prompt,provider_response_id,metadata,style_generation)
          VALUES(v,a,CASE WHEN j.operation = 'inpaint' THEN j.parent_version_id WHEN j.operation = 'image_to_image' THEN (j.input->>'source_version_id')::uuid ELSE NULL END,'web_openai',r->>'storage_path',r->>'mime_type',(r->>'width')::integer,(r->>'height')::integer,(r->>'byte_size')::bigint,r->>'prompt',r->>'provider_response_id',v_meta||v_lineage,j.style_generation);
        UPDATE public.assets SET current_version_id = v, updated_at = now() WHERE id = a;
      END IF;
    ELSIF j.operation = 'inpaint' THEN
      IF n > 0 OR a <> j.asset_id OR NOT EXISTS (SELECT 1 FROM public.asset_versions WHERE id = j.parent_version_id AND asset_id = a) THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
      INSERT INTO public.asset_versions(id,asset_id,parent_version_id,source,storage_path,mime_type,width,height,byte_size,prompt,provider_response_id,metadata)
        VALUES(v,a,j.parent_version_id,'web_openai',r->>'storage_path',r->>'mime_type',(r->>'width')::integer,(r->>'height')::integer,(r->>'byte_size')::bigint,r->>'prompt',r->>'provider_response_id',r->'metadata');
      UPDATE public.assets SET current_version_id = v, name = coalesce(nullif(btrim(r->>'name'),''), name), updated_at = now() WHERE id = a;
    ELSE
      IF j.project_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.projects WHERE id = j.project_id AND workspace_id = j.workspace_id) THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
      INSERT INTO public.assets(id,project_id,name,kind) VALUES(a,j.project_id,coalesce(nullif(btrim(r->>'name'),''),'Untitled'),'generated');
      INSERT INTO public.asset_versions(id,asset_id,source,storage_path,mime_type,width,height,byte_size,prompt,provider_response_id,metadata)
        VALUES(v,a,'web_openai',r->>'storage_path',r->>'mime_type',(r->>'width')::integer,(r->>'height')::integer,(r->>'byte_size')::bigint,r->>'prompt',r->>'provider_response_id',r->'metadata');
      UPDATE public.assets SET current_version_id = v, updated_at = now() WHERE id = a;
    END IF;
    n := n + 1;
  END LOOP;
  UPDATE public.ai_jobs SET status='succeeded',asset_id=(p_results->0->>'asset_id')::uuid,version_id=(p_results->0->>'version_id')::uuid,provider_request_id=p_provider_request_id,provider_status=p_provider_status,output=coalesce(p_output,'{}'::jsonb),lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,error_message=NULL,completed_at=now(),updated_at=now() WHERE id=p_job_id RETURNING * INTO j;
  RETURN j;
END; $$;
REVOKE ALL ON FUNCTION public.complete_ai_job_with_results(uuid,text,text,text,jsonb,jsonb) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_ai_job_with_results(uuid,text,text,text,jsonb,jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- 6b. Style job validation follows the same authority rule
-- ---------------------------------------------------------------------------

-- The original trigger required the style to be active for every style job.
-- An edit is defined by its source image instead, so revising the style must not
-- make existing images uneditable.  New generation still requires the active,
-- confirmed definition (enforced again in enqueue_style_group_job).
CREATE OR REPLACE FUNCTION public.validate_ai_job_style_id()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.module = 'style' THEN
    IF NEW.style_id IS NULL THEN
      RAISE EXCEPTION 'STYLE_REQUIRED' USING errcode = 'P0002';
    END IF;
    IF NEW.operation <> 'inpaint'
       AND NOT EXISTS (SELECT 1 FROM public.styles WHERE id = NEW.style_id AND workspace_id = NEW.workspace_id AND status = 'active') THEN
      RAISE EXCEPTION 'STYLE_NOT_ACTIVE' USING errcode = 'P0002';
    END IF;
    IF NEW.operation = 'inpaint'
       AND NOT EXISTS (SELECT 1 FROM public.styles WHERE id = NEW.style_id AND workspace_id = NEW.workspace_id) THEN
      RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002';
    END IF;
    IF NEW.style_id != (NEW.input->>'style_id')::uuid THEN
      RAISE EXCEPTION 'STYLE_ID_MISMATCH' USING errcode = '22023';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

-- ---------------------------------------------------------------------------
-- 7. Analysis commit that proves the analysed reference set
-- ---------------------------------------------------------------------------

-- commit_style_schema_mutation() only compares timestamps.  Analysis needs the
-- stronger guarantee that the reference set it actually read is still the live
-- set when the result is written, so the whole check runs in one transaction.
CREATE OR REPLACE FUNCTION public.commit_style_analysis(
  p_style_id uuid,
  p_expected_updated_at timestamptz,
  p_reference_snapshot jsonb,
  p_schema jsonb,
  p_fingerprint jsonb,
  p_invariant_contract jsonb,
  p_style_fields jsonb,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS public.styles LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_style public.styles; v_live jsonb;
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT * INTO v_style FROM public.styles
    WHERE id = p_style_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF v_style.id IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_expected_updated_at IS NULL OR v_style.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'STYLE_ANALYSIS_STALE' USING errcode = '23000'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'content_hash', r.content_hash) ORDER BY r.created_at, r.id), '[]'::jsonb)
    INTO v_live FROM public.style_references r WHERE r.style_id = p_style_id AND r.retired_at IS NULL;
  IF jsonb_typeof(p_reference_snapshot) <> 'array'
     OR jsonb_array_length(p_reference_snapshot) <> jsonb_array_length(v_live)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_reference_snapshot) s
       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_live) l
         WHERE l->>'id' = s->>'id' AND coalesce(l->>'content_hash','') = coalesce(s->>'content_hash',''))
     ) THEN
    RAISE EXCEPTION 'STYLE_ANALYSIS_STALE' USING errcode = '23000'; END IF;

  UPDATE public.styles SET
      schema = p_schema,
      fingerprint = p_fingerprint,
      invariant_contract = p_invariant_contract,
      name = CASE WHEN p_style_fields ? 'name' THEN coalesce(p_style_fields->>'name', name) ELSE name END,
      status = CASE WHEN p_style_fields ? 'status' THEN coalesce(p_style_fields->>'status', status) ELSE status END,
      library_id = CASE WHEN p_style_fields ? 'library_id' THEN (p_style_fields->>'library_id')::uuid ELSE library_id END,
      analysis_meta = CASE WHEN p_style_fields ? 'analysis_meta' THEN p_style_fields->'analysis_meta' ELSE analysis_meta END,
      clarification_questions = CASE WHEN p_style_fields ? 'clarification_questions' THEN p_style_fields->'clarification_questions' ELSE clarification_questions END,
      clarification_answers = CASE WHEN p_style_fields ? 'clarification_answers' THEN p_style_fields->'clarification_answers' ELSE clarification_answers END,
      operability = CASE WHEN p_style_fields ? 'operability' THEN p_style_fields->'operability' ELSE operability END,
      last_fidelity = CASE WHEN p_style_fields ? 'last_fidelity' THEN p_style_fields->'last_fidelity' ELSE last_fidelity END,
      updated_at = now()
    WHERE id = p_style_id RETURNING * INTO v_style;

  INSERT INTO public.style_schema_versions(style_id, source, schema, fingerprint, invariant_contract, metadata)
    VALUES (p_style_id, 'analysis', p_schema, p_fingerprint, p_invariant_contract, p_metadata);
  RETURN v_style;
END; $$;
REVOKE ALL ON FUNCTION public.commit_style_analysis(uuid,timestamptz,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.commit_style_analysis(uuid,timestamptz,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Backfill provable confirmed definitions (service-role, idempotent)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.backfill_style_definitions()
RETURNS TABLE(confirmed integer, needs_review integer, untouched integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_style record; v_live jsonb; v_hashes jsonb; v_confirmed integer := 0; v_review integer := 0; v_untouched integer := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501'; END IF;
  FOR v_style IN SELECT * FROM public.styles WHERE confirmed_definition IS NULL FOR UPDATE LOOP
    IF v_style.status <> 'active' THEN v_untouched := v_untouched + 1; CONTINUE; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'content_hash', r.content_hash) ORDER BY r.created_at, r.id), '[]'::jsonb)
      INTO v_live FROM public.style_references r WHERE r.style_id = v_style.id AND r.retired_at IS NULL;
    v_hashes := v_style.analysis_meta->'referenceHashes';
    -- Only provable correspondence may be confirmed: the stored analysis must
    -- have recorded exactly these live references, in count and in hash.  An
    -- operability grade is deliberately not required here because analyses
    -- written before that scorer existed never recorded one; the durable
    -- evidence is the schema, fingerprint, contract, timestamp and hashes.
    IF jsonb_typeof(v_style.schema) = 'object'
       AND jsonb_typeof(v_style.fingerprint) = 'object'
       AND jsonb_typeof(v_style.invariant_contract) = 'object'
       AND (v_style.analysis_meta->>'analyzedAt') IS NOT NULL
       AND (v_style.analysis_meta->>'referenceCount')::integer = jsonb_array_length(v_live)
       AND jsonb_array_length(v_live) BETWEEN 1 AND 8
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_live) e WHERE coalesce(e->>'content_hash','') !~ '^[0-9a-f]{64}$')
       AND (v_hashes IS NULL OR v_hashes = (SELECT coalesce(jsonb_agg(e->>'content_hash'), '[]'::jsonb) FROM jsonb_array_elements(v_live) e)) THEN
      PERFORM set_config('app.style_definition_write','on',true);
      UPDATE public.styles SET confirmed_definition = jsonb_build_object(
          'definition_version', 1,
          'style_revision', gen_random_uuid(),
          'schema_snapshot', v_style.schema,
          'reference_snapshot', v_live,
          'confirmed_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
        analysis_meta = v_style.analysis_meta || jsonb_build_object('reference_snapshot', v_live)
        WHERE id = v_style.id;
      v_confirmed := v_confirmed + 1;
    ELSE
      PERFORM set_config('app.style_definition_write','on',true);
      UPDATE public.styles SET confirmed_definition = NULL, status = 'draft' WHERE id = v_style.id;
      v_review := v_review + 1;
    END IF;
  END LOOP;
  RETURN QUERY SELECT v_confirmed, v_review, v_untouched;
END; $$;
REVOKE ALL ON FUNCTION public.backfill_style_definitions() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_style_definitions() TO service_role;

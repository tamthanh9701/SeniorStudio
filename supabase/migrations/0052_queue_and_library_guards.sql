-- 0052_queue_and_library_guards.sql
-- Three review findings that all reach into the same two functions.
--
-- 1. Enqueue and hard delete did not serialize. The enqueue took no lock on the
--    style row, so it could insert a job while the delete was already past its
--    busy check: the delete then removed a job the caller had been told was
--    queued. Symmetrically the busy check was a plain read, so a worker could
--    claim (and pay for) a job between the check and the delete. The enqueue now
--    takes FOR SHARE and the delete locks the non-terminal jobs it judges.
-- 2. A borrowed reference was validated against the library alone. styles.library_id
--    is writable through PostgREST, so a member could point their own style at a
--    foreign library and reference a row from another workspace; only the worker's
--    ownership check stopped the bytes from being read. The validation now
--    requires the lending style to be in the same workspace.
-- 0001-0051 remain immutable.

CREATE OR REPLACE FUNCTION public.enqueue_style_group_job(
  p_style_id uuid, p_requested_by uuid, p_operation text, p_model text,
  p_packet jsonb, p_mask_id uuid DEFAULT NULL
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.ai_jobs; v_workspace uuid; v_reservation uuid; v_mask public.ai_job_inputs;
  v_source uuid; v_asset uuid; v_count integer; v_provider text; v_input jsonb;
  v_ref_ids jsonb; v_cost_mode text; v_style public.styles; v_authority jsonb;
  v_snapshot jsonb; v_fallback boolean; v_packet_refs jsonb; v_library_ids jsonb;
BEGIN
  IF auth.role() <> 'authenticated' OR auth.uid() <> p_requested_by THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  -- FOR SHARE: an enqueue and the style's hard delete now serialize on this row,
  -- so a job can neither be inserted into a style being deleted nor be deleted
  -- silently after the caller was told it was queued.
  SELECT * INTO v_style FROM public.styles WHERE id = p_style_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR SHARE;
  IF v_style.id IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_operation NOT IN ('text_to_image','image_to_image','inpaint') OR p_packet IS NULL OR jsonb_typeof(p_packet) <> 'object' OR (p_packet->>'packet_version')::int <> 1 OR (p_packet->>'style_id')::uuid <> p_style_id THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
  IF p_packet ? 'background' AND p_packet->>'background' IS NOT NULL AND p_packet->>'background' <> 'transparent' THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
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
  -- References may also be borrowed from another style of the same library. A
  -- borrowed image is only legal while it is live and its library matches, so a
  -- revoked or unrelated image can never reach a provider.
  v_library_ids := coalesce(p_packet->'metadata'->'library_reference_ids','[]'::jsonb);
  IF jsonb_typeof(v_library_ids) <> 'array' THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
  IF jsonb_array_length(v_library_ids) > 0 THEN
    IF v_style.library_id IS NULL OR p_operation = 'inpaint' THEN RAISE EXCEPTION 'REFERENCE_NOT_FOUND' USING errcode = 'P0002'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_library_ids) l
        WHERE NOT EXISTS (SELECT 1 FROM public.style_references sr
          JOIN public.styles owner ON owner.id = sr.style_id
          WHERE sr.id = l::uuid AND sr.retired_at IS NULL AND owner.library_id = v_style.library_id
            AND owner.workspace_id = v_style.workspace_id)) THEN
      RAISE EXCEPTION 'REFERENCE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  END IF;
  v_packet_refs := coalesce(p_packet->'reference_snapshot','[]'::jsonb);
  -- Every reference must be either a confirmed one (with the recorded hash) or a
  -- live borrowed one; nothing else can enter a job.
  IF jsonb_array_length(v_packet_refs) NOT BETWEEN 1 AND jsonb_array_length(v_snapshot) + jsonb_array_length(v_library_ids) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_packet_refs) r
       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_snapshot) s
           WHERE s->>'id' = r->>'id' AND coalesce(s->>'content_hash','') = coalesce(r->>'content_hash',''))
         AND NOT EXISTS (SELECT 1 FROM public.style_references sr
           JOIN public.styles owner ON owner.id = sr.style_id
           WHERE sr.id = (r->>'id')::uuid AND sr.retired_at IS NULL AND owner.library_id = v_style.library_id
             AND owner.workspace_id = v_style.workspace_id
             AND coalesce(sr.content_hash,'') = coalesce(r->>'content_hash','')
             AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_library_ids) l WHERE l::uuid = sr.id))
     ) THEN RAISE EXCEPTION 'REFERENCE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  -- Equal lengths used to make duplicates impossible; the subset rule needs its own guard.
  IF (SELECT count(DISTINCT r->>'id') FROM jsonb_array_elements(v_packet_refs) r) <> jsonb_array_length(v_packet_refs) THEN
    RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
  -- Rows must still exist for the style with the recorded hash; retired rows are
  -- valid here because an authorized snapshot is resolving them. Sent packet
  -- references are checked above (own snapshot or live borrowed row).
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
    -- background is an optional literal: emit the key only when it was asked for,
    -- never a json null (AiJobInputSchema rejects the string "null").
    v_input := jsonb_build_object('prompt',p_packet->>'compiled_prompt','count',v_count,'size',p_packet->>'size','quality',p_packet->>'quality','style_id',p_style_id,'original_prompt',p_packet->>'original_prompt','source_version_id',v_source,'reference_ids',v_ref_ids)
      || CASE WHEN v_cost_mode IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cost_mode',v_cost_mode) END
      || CASE WHEN p_packet->>'background' = 'transparent' THEN jsonb_build_object('background','transparent') ELSE '{}'::jsonb END;
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

CREATE OR REPLACE FUNCTION public.delete_style_hard(p_style_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_style public.styles; v_job record; v_images integer; v_references integer; v_jobs integer; v_paths text[];
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT * INTO v_style FROM public.styles
    WHERE id = p_style_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF v_style.id IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  -- Lock the jobs first: without this a queued job could be claimed by a worker
  -- (provider paid for) between the check and the delete below.
  PERFORM 1 FROM public.ai_jobs WHERE style_id = p_style_id
     AND status IN ('queued','submitting','processing','persisting') FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'STYLE_BUSY' USING errcode = '22023';
  END IF;
  SELECT count(*) INTO v_images FROM public.assets WHERE style_id = p_style_id;
  SELECT count(*) INTO v_references FROM public.style_references WHERE style_id = p_style_id;
  SELECT count(*) INTO v_jobs FROM public.ai_jobs WHERE style_id = p_style_id;
  -- Only this style's own objects: the client removes these with the service
  -- role, and the rows carrying them are writable by workspace members.
  SELECT coalesce(array_agg(DISTINCT path), '{}'::text[]) INTO v_paths FROM (
    SELECT sr.storage_path AS path FROM public.style_references sr
      WHERE sr.style_id = p_style_id AND sr.storage_path LIKE v_style.workspace_id::text || '/styles/' || p_style_id::text || '/%'
    UNION ALL
    SELECT av.storage_path FROM public.asset_versions av JOIN public.assets a ON a.id = av.asset_id
      WHERE a.style_id = p_style_id AND av.storage_path LIKE v_style.workspace_id::text || '/styles/' || p_style_id::text || '/%'
    UNION ALL
    SELECT ji.storage_path FROM public.ai_job_inputs ji
      WHERE ji.style_id = p_style_id AND ji.storage_path LIKE v_style.workspace_id::text || '/styles/' || p_style_id::text || '/%'
  ) paths;
  -- Reservations first: the accounting row survives the job delete (FK is SET NULL)
  -- and a released reservation is idempotent.
  FOR v_job IN SELECT quota_reservation_id FROM public.ai_jobs WHERE style_id = p_style_id LOOP
    PERFORM public.release_ai_reservation_internal(v_job.quota_reservation_id);
  END LOOP;
  DELETE FROM public.ai_jobs WHERE style_id = p_style_id;
  DELETE FROM public.ai_job_inputs WHERE style_id = p_style_id;
  DELETE FROM public.styles WHERE id = p_style_id;
  RETURN jsonb_build_object('images', v_images, 'references', v_references, 'jobs', v_jobs, 'storage_paths', to_jsonb(v_paths));
END; $$;
REVOKE ALL ON FUNCTION public.delete_style_hard(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delete_style_hard(uuid) TO authenticated;

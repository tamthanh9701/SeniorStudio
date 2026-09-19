-- 0058_game_ui_jobs.sql
-- Job integration for the Game UI domain: request idempotency, a version-2
-- generation packet whose authority is the confirmed Game UI definition (or the
-- render it was generated from), render creation and element-output creation in
-- the same transaction that completes a job, and ordered cleanup on style delete.
-- 0001-0057 remain immutable.

-- ---------------------------------------------------------------------------
-- 1. Idempotency key
-- ---------------------------------------------------------------------------

-- A retried request must not pay twice.  The key is caller-supplied and only
-- Game UI packets carry one, so existing visual requests are untouched.
ALTER TABLE public.ai_jobs ADD COLUMN IF NOT EXISTS request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS ai_jobs_request_idempotency_idx
  ON public.ai_jobs(requested_by, request_id) WHERE request_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Only version-2 packets may reach a Game UI style
-- ---------------------------------------------------------------------------

-- Every legacy enqueue path (project jobs carrying a style, older overloads,
-- direct inserts) must not be able to create a job for a Game UI style: those
-- paths know nothing about screens, element sets or the version-2 authority.
CREATE OR REPLACE FUNCTION public.guard_game_ui_style_jobs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.module = 'style' AND NEW.style_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.styles s WHERE s.id = NEW.style_id AND s.domain = 'game_ui')
     AND coalesce(NEW.style_generation->>'packet_version', '') <> '2' THEN
    RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS guard_game_ui_style_jobs_trigger ON public.ai_jobs;
CREATE TRIGGER guard_game_ui_style_jobs_trigger BEFORE INSERT ON public.ai_jobs
FOR EACH ROW EXECUTE FUNCTION public.guard_game_ui_style_jobs();

-- ---------------------------------------------------------------------------
-- 3. Enqueue: version 1 visual packets unchanged, version 2 Game UI packets
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enqueue_style_group_job(
  p_style_id uuid, p_requested_by uuid, p_operation text, p_model text,
  p_packet jsonb, p_mask_id uuid DEFAULT NULL
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.ai_jobs; v_workspace uuid; v_reservation uuid; v_mask public.ai_job_inputs;
  v_source uuid; v_asset uuid; v_count integer; v_provider text; v_input jsonb;
  v_ref_ids jsonb; v_cost_mode text; v_style public.styles; v_authority jsonb;
  v_snapshot jsonb; v_fallback boolean; v_packet_refs jsonb; v_library_ids jsonb;
  v_packet_version integer; v_intent text; v_context jsonb; v_request_id uuid;
  v_existing public.ai_jobs; v_screen public.game_ui_screens; v_render public.game_ui_renders;
  v_set public.game_ui_element_sets; v_element jsonb; v_wireframe public.game_ui_inputs;
  v_render_authority jsonb; v_source_hash text; v_game_ui jsonb;
BEGIN
  IF auth.role() <> 'authenticated' OR auth.uid() <> p_requested_by THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  -- FOR SHARE: an enqueue and the style's hard delete now serialize on this row,
  -- so a job can neither be inserted into a style being deleted nor be deleted
  -- silently after the caller was told it was queued.
  SELECT * INTO v_style FROM public.styles WHERE id = p_style_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR SHARE;
  IF v_style.id IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_packet IS NULL OR jsonb_typeof(p_packet) <> 'object' THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
  v_packet_version := coalesce((p_packet->>'packet_version')::int, 0);
  IF v_packet_version NOT IN (1,2) OR coalesce(p_packet->>'style_id','') <> p_style_id::text THEN
    RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
  -- A packet version belongs to exactly one domain: a visual style cannot be
  -- generated from a Game UI definition and vice versa.
  IF v_packet_version = 1 AND v_style.domain <> 'visual' THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
  IF v_packet_version = 2 AND (v_style.domain <> 'game_ui' OR coalesce(p_packet->>'domain','') <> 'game_ui') THEN
    RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
  IF p_operation NOT IN ('text_to_image','image_to_image','inpaint') OR p_packet->>'operation' <> p_operation OR p_packet->>'model' <> p_model OR char_length(btrim(coalesce(p_packet->>'compiled_prompt',''))) NOT BETWEEN 1 AND 8000 OR p_packet->>'original_prompt' IS NULL OR jsonb_typeof(p_packet->'reference_snapshot') <> 'array' OR jsonb_typeof(p_packet->'schema_snapshot') <> 'object' THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
  IF p_packet ? 'background' AND p_packet->>'background' IS NOT NULL AND p_packet->>'background' <> 'transparent' THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
  IF p_model LIKE 'openai/%' THEN v_provider := 'openai'; ELSIF p_model LIKE 'google/%' THEN v_provider := 'google'; ELSE RAISE EXCEPTION 'INVALID_MODEL' USING errcode = '22023'; END IF;
  v_count := COALESCE((p_packet->>'count')::int, 1);
  IF v_count NOT BETWEEN 1 AND 4 OR p_packet->>'quality' NOT IN ('low','medium','high','auto') OR p_packet->>'size' NOT IN ('1024x1024','1536x1024','1024x1536','auto') THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
  v_fallback := coalesce(p_packet->'metadata'->>'style_provenance','') = 'current_style_fallback';
  IF v_packet_version = 2 AND v_fallback THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;

  IF v_packet_version = 1 THEN
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
  ELSE
    v_intent := coalesce(p_packet->>'intent','');
    v_context := p_packet->'context';
    IF v_intent NOT IN ('screen','element_reconstruction') OR jsonb_typeof(v_context) <> 'object' THEN
      RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
    IF NOT public.is_game_ui_uuid(v_context->>'screen_id') THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
    SELECT * INTO v_screen FROM public.game_ui_screens
      WHERE id = (v_context->>'screen_id')::uuid AND style_id = p_style_id AND workspace_id = v_style.workspace_id FOR SHARE;
    IF v_screen.id IS NULL THEN RAISE EXCEPTION 'SCREEN_NOT_FOUND' USING errcode = 'P0002'; END IF;
    v_request_id := CASE WHEN public.is_game_ui_uuid(v_context->>'request_id') THEN (v_context->>'request_id')::uuid ELSE NULL END;
    IF v_request_id IS NULL THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;

    IF v_intent = 'screen' THEN
      -- The draft the packet was planned from must still be the draft on screen:
      -- otherwise the user consents to one screen and pays for another.
      IF coalesce((v_context->>'draft_revision')::bigint, -1) <> v_screen.draft_revision
         OR v_context->'spec_snapshot' IS DISTINCT FROM v_screen.draft_spec THEN
        RAISE EXCEPTION 'SCREEN_VERSION_CONFLICT' USING errcode = '23000'; END IF;
      IF v_style.status <> 'active' OR jsonb_typeof(v_style.confirmed_definition) <> 'object'
         OR coalesce((v_style.confirmed_definition->>'definition_version')::int, 0) <> 2 THEN
        RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;
      v_authority := v_style.confirmed_definition;
      v_source := NULL;
      v_source_hash := v_context->>'source_content_hash';
      IF v_context->>'wireframe_input_id' IS NOT NULL THEN
        IF NOT public.is_game_ui_uuid(v_context->>'wireframe_input_id') THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
        SELECT * INTO v_wireframe FROM public.game_ui_inputs
          WHERE id = (v_context->>'wireframe_input_id')::uuid AND kind = 'wireframe' AND style_id = p_style_id
            AND workspace_id = v_style.workspace_id FOR SHARE;
        IF v_wireframe.id IS NULL THEN RAISE EXCEPTION 'INPUT_NOT_FOUND' USING errcode = 'P0002'; END IF;
        -- A wireframe is a real layout input: the job submits its bytes, so the
        -- recorded hash must be the one the packet was planned against.
        IF v_wireframe.version_id IS DISTINCT FROM v_screen.wireframe_version_id OR coalesce(v_source_hash,'') <> v_wireframe.content_hash THEN
          RAISE EXCEPTION 'SCREEN_VERSION_CONFLICT' USING errcode = '23000'; END IF;
        IF p_operation <> 'image_to_image' OR (p_packet->>'source_version_id')::uuid IS DISTINCT FROM v_wireframe.version_id THEN
          RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
        v_source := v_wireframe.version_id;
        SELECT av.asset_id INTO v_asset FROM public.asset_versions av
          WHERE av.id = v_source AND EXISTS (SELECT 1 FROM public.assets a WHERE a.id = av.asset_id AND a.style_id = p_style_id);
        IF v_asset IS NULL THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND' USING errcode = 'P0002'; END IF;
      ELSE
        IF v_screen.wireframe_version_id IS NOT NULL THEN RAISE EXCEPTION 'SCREEN_VERSION_CONFLICT' USING errcode = '23000'; END IF;
        IF p_operation <> 'text_to_image' OR (p_packet->>'source_version_id') IS NOT NULL OR v_source_hash IS NOT NULL THEN
          RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
      END IF;
    ELSE
      -- Reconstruction is defined by the render it came from: original style
      -- revision, the saved element-set revision and the element's own box.
      IF NOT public.is_game_ui_uuid(v_context->>'render_id') OR NOT public.is_game_ui_uuid(v_context->>'element_set_id')
         OR NOT public.is_game_ui_uuid(v_context->>'element_id') OR jsonb_typeof(v_context->'element_snapshot') <> 'object' THEN
        RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
      SELECT * INTO v_render FROM public.game_ui_renders
        WHERE id = (v_context->>'render_id')::uuid AND style_id = p_style_id AND screen_id = v_screen.id
          AND workspace_id = v_style.workspace_id FOR SHARE;
      IF v_render.id IS NULL THEN RAISE EXCEPTION 'RENDER_NOT_FOUND' USING errcode = 'P0002'; END IF;
      SELECT av.style_generation INTO v_render_authority FROM public.asset_versions av
        WHERE av.id = v_render.version_id AND av.asset_id = v_render.asset_id;
      IF v_render_authority IS NULL OR coalesce(v_render_authority->>'packet_version','') <> '2' THEN
        RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;
      v_authority := v_render_authority;
      SELECT * INTO v_set FROM public.game_ui_element_sets
        WHERE id = (v_context->>'element_set_id')::uuid AND render_id = v_render.id;
      IF v_set.id IS NULL THEN RAISE EXCEPTION 'RENDER_NOT_FOUND' USING errcode = 'P0002'; END IF;
      -- Only the newest revision may be reconstructed: an older map describes
      -- pixels the user has already revised.
      IF v_set.revision <> (SELECT max(revision) FROM public.game_ui_element_sets WHERE render_id = v_render.id) THEN
        RAISE EXCEPTION 'SCREEN_VERSION_CONFLICT' USING errcode = '23000'; END IF;
      SELECT value INTO v_element FROM jsonb_array_elements(v_set.document->'elements')
        WHERE value->>'id' = v_context->>'element_id';
      IF v_element IS NULL OR v_element->>'kind' = 'group' OR v_element IS DISTINCT FROM v_context->'element_snapshot' THEN
        RAISE EXCEPTION 'ELEMENT_NOT_FOUND' USING errcode = 'P0002'; END IF;
      IF p_operation <> 'image_to_image' OR (p_packet->>'source_version_id')::uuid IS DISTINCT FROM v_render.version_id
         OR v_count <> 1 OR coalesce(p_packet->>'background','') <> 'transparent' THEN
        RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
      v_source := v_render.version_id;
      v_asset := v_render.asset_id;
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
  -- borrowed image is only legal while it is live, in the same workspace and in
  -- the same domain, so a revoked or unrelated image can never reach a provider.
  v_library_ids := coalesce(p_packet->'metadata'->'library_reference_ids','[]'::jsonb);
  IF jsonb_typeof(v_library_ids) <> 'array' THEN RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023'; END IF;
  IF jsonb_array_length(v_library_ids) > 0 THEN
    IF v_style.library_id IS NULL OR p_operation = 'inpaint' THEN RAISE EXCEPTION 'REFERENCE_NOT_FOUND' USING errcode = 'P0002'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_library_ids) l
        WHERE NOT EXISTS (SELECT 1 FROM public.style_references sr
          JOIN public.styles owner ON owner.id = sr.style_id
          WHERE sr.id = l::uuid AND sr.retired_at IS NULL AND owner.library_id = v_style.library_id
            AND owner.workspace_id = v_style.workspace_id AND owner.domain = v_style.domain)) THEN
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
             AND owner.workspace_id = v_style.workspace_id AND owner.domain = v_style.domain
             AND coalesce(sr.content_hash,'') = coalesce(r->>'content_hash','')
             AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_library_ids) l WHERE l::uuid = sr.id))
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

  v_cost_mode := p_packet->>'cost_mode';
  IF v_cost_mode IS NOT NULL AND v_cost_mode NOT IN ('strict_style','strict_1000','balanced','quality') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;

  IF p_operation = 'inpaint' THEN
    IF p_mask_id IS NULL THEN RAISE EXCEPTION 'MASK_REQUIRED' USING errcode = '22023'; END IF;
    SELECT * INTO v_mask FROM public.ai_job_inputs WHERE id = p_mask_id AND workspace_id = v_style.workspace_id AND style_id = p_style_id AND job_id IS NULL AND expires_at > now() FOR UPDATE;
    IF v_mask.id IS NULL OR v_mask.parent_version_id IS DISTINCT FROM v_source THEN RAISE EXCEPTION 'MASK_NOT_FOUND' USING errcode = 'P0002'; END IF;
    v_input := jsonb_build_object('prompt',p_packet->>'compiled_prompt','count',1,'size','auto','quality',p_packet->>'quality','style_id',p_style_id,'original_prompt',p_packet->>'original_prompt','source_version_id',v_source,'mask_id',p_mask_id,'mask_storage_path',v_mask.storage_path,'edit_target',p_packet->'edit'->>'target','reference_ids',v_ref_ids);
    v_count := 1;
  ELSE
    -- cost_mode is an optional enum in AiJobInputSchema: omit the key unless a
    -- valid enum value is present, never emit json null.
    -- background is an optional literal: emit the key only when it was asked for.
    v_input := jsonb_build_object('prompt',p_packet->>'compiled_prompt','count',v_count,'size',p_packet->>'size','quality',p_packet->>'quality','style_id',p_style_id,'original_prompt',p_packet->>'original_prompt','source_version_id',v_source,'reference_ids',v_ref_ids)
      || CASE WHEN v_cost_mode IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cost_mode',v_cost_mode) END
      || CASE WHEN p_packet->>'background' = 'transparent' THEN jsonb_build_object('background','transparent') ELSE '{}'::jsonb END;
    IF v_packet_version = 2 THEN
      -- Compact routing data for job feeds: which screen, render and element a
      -- job belongs to, so the UI never has to parse the whole packet.
      v_game_ui := jsonb_build_object('intent', v_intent, 'screen_id', v_context->>'screen_id');
      IF v_intent = 'element_reconstruction' THEN
        v_game_ui := v_game_ui || jsonb_build_object('render_id', v_context->>'render_id', 'element_id', v_context->>'element_id',
                                                     'element_set_id', v_context->>'element_set_id');
      END IF;
      v_input := v_input || jsonb_build_object('game_ui', v_game_ui);
    END IF;
  END IF;
  v_workspace := v_style.workspace_id;

  IF v_request_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.ai_jobs WHERE requested_by = p_requested_by AND request_id = v_request_id;
    IF v_existing.id IS NOT NULL THEN
      -- Same request replayed: the caller gets the job it already has, and no
      -- second reservation is taken.  A different packet under the same key is a
      -- contradiction, not a retry.
      IF v_existing.style_generation IS DISTINCT FROM p_packet THEN RAISE EXCEPTION 'CONFLICT' USING errcode = '23000'; END IF;
      RETURN v_existing;
    END IF;
  END IF;

  BEGIN
    -- Reserved inside the block: a simultaneous duplicate adopts the winner's job in the
    -- handler below, and the subtransaction rollback must take this reservation with it.
    v_reservation := public.reserve_ai_quota_internal(v_workspace,'image',v_count);
    INSERT INTO public.ai_jobs(workspace_id,project_id,module,requested_by,operation,provider,model,status,input,style_id,style_generation,asset_id,parent_version_id,source_version_id,request_id)
      VALUES(v_workspace,NULL,'style',p_requested_by,p_operation,v_provider,p_model,'queued',v_input,p_style_id,p_packet,v_asset,v_source,v_source,v_request_id) RETURNING * INTO v_job;
  EXCEPTION WHEN unique_violation THEN
    -- Two simultaneous submissions of one request: the loser adopts the winner's
    -- job instead of charging a second reservation.
    IF v_request_id IS NULL THEN RAISE; END IF;
    SELECT * INTO v_existing FROM public.ai_jobs WHERE requested_by = p_requested_by AND request_id = v_request_id;
    IF v_existing.id IS NULL OR v_existing.style_generation IS DISTINCT FROM p_packet THEN RAISE EXCEPTION 'CONFLICT' USING errcode = '23000'; END IF;
    RETURN v_existing;
  END;
  IF p_mask_id IS NOT NULL THEN UPDATE public.ai_job_inputs SET job_id = v_job.id WHERE id = p_mask_id; END IF;
  RETURN public.attach_ai_quota_reservation_internal(v_job.id, v_reservation);
END; $$;
REVOKE ALL ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Completion: render rows and element outputs in the same transaction
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_ai_job_with_results(
  p_job_id uuid, p_worker_id text, p_provider_request_id text, p_provider_status text,
  p_results jsonb, p_output jsonb
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j public.ai_jobs; r jsonb; a uuid; v uuid; n integer := 0; expected integer; is_style boolean;
  v_meta jsonb; v_lineage jsonb; v_is_game_ui boolean; v_intent text; v_hash text; v_alpha text;
  v_screen_id uuid; v_render_id uuid; v_element_set_id uuid; v_element_id uuid; v_bounds jsonb;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501'; END IF;
  j := public.assert_ai_job_lease(p_job_id, p_worker_id);
  IF j.status <> 'persisting' OR jsonb_typeof(p_results) <> 'array' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  is_style := j.module = 'style';
  v_is_game_ui := is_style AND coalesce(j.style_generation->>'packet_version', '') = '2';
  v_intent := CASE WHEN v_is_game_ui THEN j.style_generation->>'intent' ELSE NULL END;
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
      -- A Game UI output is only useful with the hash of its final bytes: the
      -- manifest and every later reconstruction source check read it.
      IF v_is_game_ui THEN
        v_hash := v_meta->>'content_hash';
        IF coalesce(v_hash, '') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
      END IF;
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
        IF v_intent = 'screen' THEN
          -- One render per generated image, created here so a render always has a
          -- succeeded job and an immutable version behind it.
          v_screen_id := (j.style_generation->'context'->>'screen_id')::uuid;
          IF v_screen_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.game_ui_screens
              WHERE id = v_screen_id AND style_id = j.style_id AND workspace_id = j.workspace_id) THEN
            RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
          INSERT INTO public.game_ui_renders(workspace_id, style_id, screen_id, job_id, asset_id, version_id, spec_snapshot, style_revision)
            VALUES (j.workspace_id, j.style_id, v_screen_id, j.id, a, v,
                    j.style_generation->'context'->'spec_snapshot', (j.style_generation->>'style_revision')::uuid)
            ON CONFLICT (version_id) DO NOTHING;
        ELSIF v_intent = 'element_reconstruction' THEN
          -- A reconstructed element is a separate image, never an edit of the
          -- screen: the screen stays exactly as generated.
          v_render_id := (j.style_generation->'context'->>'render_id')::uuid;
          v_element_set_id := (j.style_generation->'context'->>'element_set_id')::uuid;
          v_element_id := (j.style_generation->'context'->>'element_id')::uuid;
          IF v_render_id IS NULL OR v_element_set_id IS NULL OR v_element_id IS NULL THEN
            RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
          IF NOT EXISTS (SELECT 1 FROM public.game_ui_renders gr JOIN public.game_ui_element_sets gs ON gs.render_id = gr.id
                         WHERE gr.id = v_render_id AND gr.style_id = j.style_id AND gr.workspace_id = j.workspace_id
                           AND gs.id = v_element_set_id) THEN
            RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
          IF NOT EXISTS (SELECT 1 FROM public.game_ui_element_sets gs
                         WHERE gs.id = v_element_set_id
                           AND EXISTS (SELECT 1 FROM jsonb_array_elements(gs.document->'elements') e WHERE e->>'id' = v_element_id::text)) THEN
            RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
          v_alpha := v_meta->>'alpha_status';
          -- An opaque "element" is not an element: it would carry the screen
          -- around it into the pack.
          IF v_alpha <> 'transparent' THEN RAISE EXCEPTION 'TRANSPARENCY_REQUIRED' USING errcode = '22023'; END IF;
          v_bounds := j.style_generation->'context'->'element_snapshot'->'bounds';
          INSERT INTO public.game_ui_element_outputs(workspace_id, render_id, element_set_id, element_id, mode, matte_input_id, job_id,
              asset_id, version_id, alpha_status, source_bounds, provider, model)
            VALUES (j.workspace_id, v_render_id, v_element_set_id, v_element_id, 'reconstructed', NULL, j.id,
                    a, v, v_alpha, v_bounds, j.provider, j.model)
            ON CONFLICT (version_id) DO NOTHING;
        END IF;
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
-- 5. Style hard delete owns the Game UI rows and paths
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_style_hard(p_style_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_style public.styles; v_job record; v_images integer; v_references integer; v_jobs integer; v_paths text[];
  v_screens integer; v_renders integer; v_element_sets integer; v_inputs integer; v_outputs integer;
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
  SELECT count(*) INTO v_screens FROM public.game_ui_screens WHERE style_id = p_style_id;
  SELECT count(*) INTO v_renders FROM public.game_ui_renders WHERE style_id = p_style_id;
  SELECT count(*) INTO v_element_sets FROM public.game_ui_element_sets WHERE render_id IN (SELECT id FROM public.game_ui_renders WHERE style_id = p_style_id);
  SELECT count(*) INTO v_inputs FROM public.game_ui_inputs WHERE style_id = p_style_id;
  SELECT count(*) INTO v_outputs FROM public.game_ui_element_outputs WHERE render_id IN (SELECT id FROM public.game_ui_renders WHERE style_id = p_style_id);
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
    UNION ALL
    SELECT gu.storage_path FROM public.game_ui_uploads gu
      WHERE gu.style_id = p_style_id AND gu.storage_path LIKE v_style.workspace_id::text || '/styles/' || p_style_id::text || '/%'
  ) paths;
  -- Game UI rows first: they reference style assets and jobs with RESTRICT, so
  -- deleting styles before them would fail on a foreign key instead of cleaning up.
  DELETE FROM public.game_ui_element_outputs WHERE render_id IN (SELECT id FROM public.game_ui_renders WHERE style_id = p_style_id);
  DELETE FROM public.game_ui_inputs WHERE style_id = p_style_id;
  DELETE FROM public.game_ui_element_sets WHERE render_id IN (SELECT id FROM public.game_ui_renders WHERE style_id = p_style_id);
  DELETE FROM public.game_ui_renders WHERE style_id = p_style_id;
  DELETE FROM public.game_ui_screens WHERE style_id = p_style_id;
  DELETE FROM public.game_ui_uploads WHERE style_id = p_style_id;
  -- Reservations first: the accounting row survives the job delete (FK is SET NULL)
  -- and a released reservation is idempotent.
  FOR v_job IN SELECT quota_reservation_id FROM public.ai_jobs WHERE style_id = p_style_id LOOP
    PERFORM public.release_ai_reservation_internal(v_job.quota_reservation_id);
  END LOOP;
  DELETE FROM public.ai_jobs WHERE style_id = p_style_id;
  DELETE FROM public.ai_job_inputs WHERE style_id = p_style_id;
  DELETE FROM public.styles WHERE id = p_style_id;
  RETURN jsonb_build_object('images', v_images, 'references', v_references, 'jobs', v_jobs, 'storage_paths', to_jsonb(v_paths),
                            'screens', v_screens, 'renders', v_renders, 'element_sets', v_element_sets,
                            'inputs', v_inputs, 'element_outputs', v_outputs);
END; $$;
REVOKE ALL ON FUNCTION public.delete_style_hard(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delete_style_hard(uuid) TO authenticated;

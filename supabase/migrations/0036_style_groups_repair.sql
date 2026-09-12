-- 0036_style_groups_repair.sql
-- Forward repair for style-group enqueue, persistence, ownership and proposal application.
-- 0001-0035 remain immutable.

-- Style masks may be owned by either a project or a style job.
ALTER TABLE public.ai_job_inputs ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE public.ai_job_inputs ADD COLUMN IF NOT EXISTS style_id uuid REFERENCES public.styles(id) ON DELETE CASCADE;
ALTER TABLE public.ai_job_inputs DROP CONSTRAINT IF EXISTS ai_job_inputs_exactly_one_owner_check;
ALTER TABLE public.ai_job_inputs ADD CONSTRAINT ai_job_inputs_exactly_one_owner_check CHECK ((project_id IS NOT NULL) <> (style_id IS NOT NULL));
ALTER TABLE public.ai_job_inputs DROP CONSTRAINT IF EXISTS ai_job_inputs_asset_id_fkey;
ALTER TABLE public.ai_job_inputs ALTER COLUMN asset_id DROP NOT NULL;
ALTER TABLE public.ai_job_inputs DROP CONSTRAINT IF EXISTS ai_job_inputs_parent_version_id_fkey;
ALTER TABLE public.ai_job_inputs ALTER COLUMN parent_version_id DROP NOT NULL;
ALTER TABLE public.ai_job_inputs ADD CONSTRAINT ai_job_inputs_parent_version_id_fkey FOREIGN KEY (parent_version_id) REFERENCES public.asset_versions(id) ON DELETE SET NULL;

-- Atomic style enqueue: validate the immutable packet, source ownership and every reference before quota/job mutation.
CREATE OR REPLACE FUNCTION public.enqueue_style_group_job(
  p_style_id uuid, p_requested_by uuid, p_operation text, p_model text,
  p_packet jsonb, p_mask_id uuid DEFAULT NULL
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.ai_jobs; v_workspace uuid; v_reservation uuid; v_mask public.ai_job_inputs;
  v_source uuid; v_count integer; v_provider text; v_input jsonb; v_ref jsonb;
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
  INSERT INTO public.ai_jobs(workspace_id,project_id,module,requested_by,operation,provider,model,status,input,style_id,style_generation)
    VALUES(v_workspace,NULL,'style',p_requested_by,p_operation,v_provider,p_model,'queued',v_input,p_style_id,p_packet) RETURNING * INTO v_job;
  IF p_mask_id IS NOT NULL THEN UPDATE public.ai_job_inputs SET job_id=v_job.id WHERE id=p_mask_id; END IF;
  RETURN public.attach_ai_quota_reservation_internal(v_job.id,v_reservation);
END; $$;
REVOKE ALL ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.enqueue_style_group_job(uuid,uuid,text,text,jsonb,uuid) TO authenticated;

-- Proposal apply is one optimistic, atomic mutation and applied marker.
CREATE OR REPLACE FUNCTION public.apply_style_proposal(p_proposal_id uuid, p_selected_change_ids text[] DEFAULT '{}') RETURNS public.styles LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p public.style_proposals; s public.styles; payload jsonb; candidate jsonb; patch jsonb; result public.styles;
BEGIN
  IF auth.role()<>'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode='P0002'; END IF;
  SELECT * INTO p FROM public.style_proposals WHERE id=p_proposal_id FOR UPDATE;
  IF p.id IS NULL OR p.applied_at IS NOT NULL THEN RAISE EXCEPTION 'STYLE_CONFLICT' USING errcode='23000'; END IF;
  SELECT * INTO s FROM public.styles WHERE id=p.style_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode='P0002'; END IF;
  IF s.updated_at<>p.base_updated_at THEN RAISE EXCEPTION 'STYLE_VERSION_CONFLICT' USING errcode='23000'; END IF;
  payload := p.payload; candidate := CASE WHEN p.kind='synthesis' THEN payload->'candidate_schema' ELSE payload->'schema' END;
  IF candidate IS NULL THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode='22023'; END IF;
  UPDATE public.styles SET schema=candidate, updated_at=now() WHERE id=s.id RETURNING * INTO result;
  UPDATE public.style_proposals SET applied_at=now() WHERE id=p.id;
  RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.apply_style_proposal(uuid,text[]) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.apply_style_proposal(uuid,text[]) TO authenticated;

-- Active jobs protect both style and mask rows; terminal success retains style masks for audit/retry resolution.
CREATE OR REPLACE FUNCTION public.block_active_job_refs_on_delete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ai_jobs WHERE (style_id=OLD.id OR input->>'style_id'=OLD.id::text) AND status NOT IN ('succeeded','failed','canceled')) THEN RAISE EXCEPTION 'STYLE_IN_USE' USING errcode='23503'; END IF;
  RETURN OLD;
END; $$;
CREATE OR REPLACE FUNCTION public.validate_ai_job_input_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF (NEW.project_id IS NULL) = (NEW.style_id IS NULL) THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode='22023'; END IF;
  IF NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.projects WHERE id=NEW.project_id AND workspace_id=NEW.workspace_id) THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode='P0002'; END IF;
  IF NEW.style_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.styles WHERE id=NEW.style_id AND workspace_id=NEW.workspace_id) THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode='P0002'; END IF;
  RETURN NEW;
END; $$;

-- Persist provider results atomically. Every style operation creates a generated asset;
-- only project inpaint appends a version to its existing asset.
CREATE OR REPLACE FUNCTION public.complete_ai_job_with_results(
  p_job_id uuid, p_worker_id text, p_provider_request_id text, p_provider_status text,
  p_results jsonb, p_output jsonb
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.ai_jobs; r jsonb; a uuid; v uuid; n integer := 0; expected integer; is_style boolean;
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
      INSERT INTO public.assets(id,style_id,name,kind) VALUES(a,j.style_id,coalesce(nullif(btrim(r->>'name'),''),'Untitled'),'generated');
      INSERT INTO public.asset_versions(id,asset_id,parent_version_id,source,storage_path,mime_type,width,height,byte_size,prompt,provider_response_id,metadata,style_generation)
        VALUES(v,a,CASE WHEN j.operation='inpaint' THEN j.parent_version_id WHEN j.operation='image_to_image' THEN (j.input->>'source_version_id')::uuid ELSE NULL END,'web_openai',r->>'storage_path',r->>'mime_type',(r->>'width')::integer,(r->>'height')::integer,(r->>'byte_size')::bigint,r->>'prompt',r->>'provider_response_id',r->'metadata',j.style_generation);
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

-- Validate canonical mask paths and protect referenced assets/versions from deletion.
CREATE OR REPLACE FUNCTION public.validate_job_input_path() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.project_id IS NOT NULL AND NEW.storage_path <> NEW.workspace_id::text||'/'||NEW.project_id::text||'/job-inputs/'||NEW.id::text||'/mask.png' THEN RAISE EXCEPTION 'INVALID_STORAGE_PATH' USING errcode='22023'; END IF;
  IF NEW.style_id IS NOT NULL AND NEW.storage_path <> NEW.workspace_id::text||'/styles/'||NEW.style_id::text||'/job-inputs/'||NEW.id::text||'/mask.png' THEN RAISE EXCEPTION 'INVALID_STORAGE_PATH' USING errcode='22023'; END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION public.block_asset_version_delete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ai_jobs WHERE (parent_version_id=OLD.id OR input->>'source_version_id'=OLD.id::text) AND status NOT IN ('succeeded','failed','canceled')) THEN RAISE EXCEPTION 'VERSION_IN_USE' USING errcode='23503'; END IF;
  RETURN OLD;
END; $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='block_asset_version_delete_trigger') THEN CREATE TRIGGER block_asset_version_delete_trigger BEFORE DELETE ON public.asset_versions FOR EACH ROW EXECUTE FUNCTION public.block_asset_version_delete(); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='validate_job_input_path_update_trigger') THEN CREATE TRIGGER validate_job_input_path_update_trigger BEFORE INSERT OR UPDATE ON public.ai_job_inputs FOR EACH ROW EXECUTE FUNCTION public.validate_job_input_path(); END IF;
END $$;

-- Compatibility overload for callers that pass an explicit cost mode; packet remains canonical.
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

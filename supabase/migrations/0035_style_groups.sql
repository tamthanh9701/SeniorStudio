-- 0035_style_groups.sql
-- Forward migration for Style Groups: job metadata, gallery, proposals, group scoped enqueue.
-- 0001–0034 remain immutable.

-- 1. ai_jobs: add style_id and style_generation columns
ALTER TABLE public.ai_jobs ADD COLUMN IF NOT EXISTS style_id uuid REFERENCES public.styles(id);
ALTER TABLE public.ai_jobs ADD COLUMN IF NOT EXISTS style_generation jsonb;

-- Backfill style_id from input.style_id for existing style jobs
UPDATE public.ai_jobs
SET style_id = (input->>'style_id')::uuid
WHERE style_id IS NULL
  AND module = 'style'
  AND input->>'style_id' IS NOT NULL
  AND (input->>'style_id')::uuid IN (SELECT id FROM public.styles);

-- Index for group-scoped job queries
CREATE INDEX IF NOT EXISTS ai_jobs_style_id_idx ON public.ai_jobs (style_id, created_at DESC, id DESC)
  WHERE module = 'style';

-- Validate style_id column matches input.style_id on inserts
CREATE OR REPLACE FUNCTION public.validate_ai_job_style_id()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.module = 'style' THEN
    IF NEW.style_id IS NULL THEN
      RAISE EXCEPTION 'STYLE_REQUIRED' USING errcode = 'P0002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.styles WHERE id = NEW.style_id AND workspace_id = NEW.workspace_id AND status = 'active') THEN
      RAISE EXCEPTION 'STYLE_NOT_ACTIVE' USING errcode = 'P0002';
    END IF;
    IF NEW.style_id != (NEW.input->>'style_id')::uuid THEN
      RAISE EXCEPTION 'STYLE_ID_MISMATCH' USING errcode = '22023';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'validate_ai_job_style_id_trigger') THEN
    CREATE TRIGGER validate_ai_job_style_id_trigger BEFORE INSERT ON public.ai_jobs
      FOR EACH ROW EXECUTE FUNCTION public.validate_ai_job_style_id();
  END IF;
END $$;

-- 2. asset_versions: style_generation column
ALTER TABLE public.asset_versions ADD COLUMN IF NOT EXISTS style_generation jsonb;

-- 3. FK parent_version_id ON DELETE SET NULL
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_versions_parent_version_id_fkey' AND conrelid = 'public.asset_versions'::regclass) THEN
    ALTER TABLE public.asset_versions DROP CONSTRAINT asset_versions_parent_version_id_fkey;
  END IF;
END $$;

ALTER TABLE public.asset_versions
  ADD CONSTRAINT asset_versions_parent_version_id_fkey
  FOREIGN KEY (parent_version_id) REFERENCES public.asset_versions(id) ON DELETE SET NULL;

-- 4. ai_job_inputs: nullable project_id, style_id, exactly-one-owner
ALTER TABLE public.ai_job_inputs ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE public.ai_job_inputs ADD COLUMN IF NOT EXISTS style_id uuid REFERENCES public.styles(id);

ALTER TABLE public.ai_job_inputs
  ADD CONSTRAINT ai_job_inputs_exactly_one_owner_check
  CHECK ((project_id IS NOT NULL) <> (style_id IS NOT NULL));

-- Validate workspace consistency for style masks
CREATE OR REPLACE FUNCTION public.validate_ai_job_input_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.style_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.styles WHERE id = NEW.style_id AND workspace_id = NEW.workspace_id) THEN
      RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002';
    END IF;
  END IF;
  IF NEW.project_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = NEW.project_id AND workspace_id = NEW.workspace_id) THEN
      RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'validate_ai_job_input_owner_trigger') THEN
    CREATE TRIGGER validate_ai_job_input_owner_trigger BEFORE INSERT OR UPDATE ON public.ai_job_inputs
      FOR EACH ROW EXECUTE FUNCTION public.validate_ai_job_input_owner();
  END IF;
END $$;

-- 5. style_proposals table
CREATE TABLE IF NOT EXISTS public.style_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  style_id uuid NOT NULL REFERENCES public.styles(id) ON DELETE CASCADE,
  base_updated_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('synthesis', 'tuning')),
  payload jsonb NOT NULL,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);

CREATE INDEX style_proposals_style_created_idx ON public.style_proposals (style_id, created_at DESC);

ALTER TABLE public.style_proposals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view style proposals in their workspace"
  ON public.style_proposals FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.styles s WHERE s.id = style_id AND s.workspace_id IN (SELECT public.current_workspace_ids())));

CREATE POLICY "Users can insert style proposals in their workspace"
  ON public.style_proposals FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.styles s WHERE s.id = style_id AND s.workspace_id IN (SELECT public.current_workspace_ids())));

-- 6. enqueue_style_group_job: authenticated group-scoped enqueue
CREATE OR REPLACE FUNCTION public.enqueue_style_group_job(
  p_style_id uuid,
  p_requested_by uuid,
  p_operation text,
  p_model text,
  p_packet jsonb,
  p_mask_id uuid DEFAULT NULL
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.ai_jobs;
  v_workspace_id uuid;
  v_provider text;
  v_reservation_id uuid;
  v_source_version_id uuid;
  v_prompt text;
  v_original_prompt text;
  v_count integer;
  v_size text;
  v_quality text;
  v_reference_ids uuid[];
  v_input jsonb;
  v_mask public.ai_job_inputs;
BEGIN
  IF auth.role() <> 'authenticated' OR auth.uid() <> p_requested_by THEN
    RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002';
  END IF;

  SELECT workspace_id INTO v_workspace_id FROM public.styles WHERE id = p_style_id AND status = 'active';
  IF v_workspace_id IS NULL OR v_workspace_id NOT IN (SELECT public.current_workspace_ids()) THEN
    RAISE EXCEPTION 'STYLE_NOT_ACTIVE' USING errcode = 'P0002';
  END IF;

  IF p_operation NOT IN ('text_to_image', 'image_to_image', 'inpaint') THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
  END IF;

  -- Validate packet structure
  IF p_packet IS NULL OR p_packet->>'packet_version' IS NULL OR (p_packet->>'packet_version')::int != 1 THEN
    RAISE EXCEPTION 'INVALID_PACKET' USING errcode = '22023';
  END IF;
  IF (p_packet->>'style_id')::uuid != p_style_id THEN
    RAISE EXCEPTION 'STYLE_ID_MISMATCH' USING errcode = '22023';
  END IF;

  v_prompt := p_packet->>'compiled_prompt';
  v_original_prompt := p_packet->>'original_prompt';
  v_size := p_packet->>'size';
  v_quality := p_packet->>'quality';
  v_count := COALESCE((p_packet->>'count')::int, 1);
  v_reference_ids := COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_packet->'reference_snapshot'->'id'))::uuid[], '{}');

  -- Resolve provider from model
  IF p_model LIKE 'openai/%' THEN v_provider := 'openai';
  ELSIF p_model LIKE 'google/%' THEN v_provider := 'google';
  ELSE RAISE EXCEPTION 'INVALID_MODEL' USING errcode = '22023';
  END IF;

  IF p_operation = 'inpaint' THEN
    IF p_mask_id IS NULL THEN
      RAISE EXCEPTION 'MASK_REQUIRED' USING errcode = '22023';
    END IF;
    SELECT * INTO v_mask FROM public.ai_job_inputs
      WHERE id = p_mask_id AND job_id IS NULL AND expires_at > now() FOR UPDATE;
    IF v_mask.id IS NULL OR v_mask.workspace_id != v_workspace_id THEN
      RAISE EXCEPTION 'MASK_NOT_FOUND' USING errcode = 'P0002';
    END IF;
    v_source_version_id := v_mask.parent_version_id;
    v_input := jsonb_build_object(
      'prompt', v_prompt, 'count', 1, 'size', 'auto', 'quality', v_quality,
      'style_id', p_style_id, 'original_prompt', v_original_prompt,
      'mask_id', p_mask_id, 'mask_storage_path', v_mask.storage_path,
      'edit_target', p_packet->'edit'->>'target'
    );
    v_count := 1;
  ELSE
    v_source_version_id := (p_packet->>'source_version_id')::uuid;
    v_input := jsonb_build_object(
      'prompt', v_prompt, 'count', v_count, 'size', v_size, 'quality', v_quality,
      'style_id', p_style_id, 'original_prompt', v_original_prompt,
      'source_version_id', v_source_version_id,
      'reference_ids', to_jsonb(v_reference_ids),
      'cost_mode', p_packet->>'cost_mode'
    );
  END IF;

  v_reservation_id := public.reserve_ai_quota_internal(v_workspace_id, 'image', v_count);

  INSERT INTO public.ai_jobs(workspace_id, project_id, module, requested_by, operation, provider, model, status, input, style_id, style_generation)
  VALUES (v_workspace_id, NULL, 'style', p_requested_by, p_operation, v_provider, p_model, 'queued', v_input, p_style_id, p_packet)
  RETURNING * INTO v_job;

  IF p_operation = 'inpaint' THEN
    UPDATE public.ai_job_inputs SET job_id = v_job.id WHERE id = p_mask_id;
  END IF;

  RETURN public.attach_ai_quota_reservation_internal(v_job.id, v_reservation_id);
END; $$;

REVOKE ALL ON FUNCTION public.enqueue_style_group_job(uuid, uuid, text, text, jsonb, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_style_group_job(uuid, uuid, text, text, jsonb, uuid) TO authenticated;

-- 7. Override complete_ai_job_with_results for style jobs
CREATE OR REPLACE FUNCTION public.complete_ai_job_with_results(
  p_job_id uuid, p_worker_id text, p_provider_request_id text, p_provider_status text,
  p_results jsonb, p_output jsonb
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.ai_jobs; r jsonb; v_asset uuid; v_ver uuid; v_n integer := 0; v_expected integer;
  v_style uuid; v_project uuid; v_parent uuid; v_kind text; v_is_style boolean;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501'; END IF;
  v_job := public.assert_ai_job_lease(p_job_id, p_worker_id);
  IF v_job.status <> 'persisting' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  IF jsonb_typeof(p_results) <> 'array' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  v_is_style := v_job.module = 'style';
  v_expected := CASE WHEN v_job.operation = 'inpaint' AND NOT v_is_style THEN 1 ELSE COALESCE((v_job.input->>'count')::integer, 0) END;
  IF jsonb_array_length(p_results) <> v_expected OR v_expected < 1 THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;

  FOR r IN SELECT value FROM jsonb_array_elements(p_results) LOOP
    IF jsonb_typeof(r) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(r)) <> 11
       OR NOT (r ?& array['asset_id','version_id','storage_path','mime_type','width','height','byte_size','name','prompt','provider_response_id','metadata'])
    THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    IF r->>'mime_type' NOT IN ('image/png','image/jpeg','image/webp') OR (r->>'width')::integer <= 0
       OR (r->>'height')::integer <= 0 OR (r->>'byte_size')::bigint <= 0 OR (r->>'byte_size')::bigint > 52428800
       OR jsonb_typeof(r->'metadata') <> 'object'
    THEN RAISE EXCEPTION 'UNSUPPORTED_IMAGE' USING errcode = '22023'; END IF;

    v_asset := (r->>'asset_id')::uuid;
    v_ver := (r->>'version_id')::uuid;

    IF v_is_style THEN
      -- Style jobs: create new asset (inpaint) or new asset (text_to_image/image_to_image)
      IF v_job.operation = 'inpaint' THEN
        -- Inpaint: reuse source asset, add version
        IF v_n > 0 OR NOT EXISTS (SELECT 1 FROM public.asset_versions WHERE id = v_job.parent_version_id AND asset_id = v_asset) THEN
          RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000';
        END IF;
        v_style := v_job.style_id;
        INSERT INTO public.asset_versions(id, asset_id, parent_version_id, source, storage_path, mime_type, width, height, byte_size, prompt, provider_response_id, metadata, style_generation)
        VALUES (v_ver, v_asset, v_job.parent_version_id, 'web_openai', r->>'storage_path', r->>'mime_type',
          (r->>'width')::integer, (r->>'height')::integer, (r->>'byte_size')::bigint,
          r->>'prompt', r->>'provider_response_id', r->'metadata', v_job.style_generation);
        UPDATE public.assets SET current_version_id = v_ver, name = coalesce(nullif(btrim(r->>'name'), ''), name), updated_at = now() WHERE id = v_asset;
      ELSE
        -- text_to_image or image_to_image: create new asset
        v_style := v_job.style_id;
        IF v_style IS NULL OR NOT EXISTS (SELECT 1 FROM public.styles WHERE id = v_style AND workspace_id = v_job.workspace_id AND status = 'active') THEN
          RAISE EXCEPTION 'STYLE_NOT_ACTIVE' USING errcode = 'P0002';
        END IF;
        INSERT INTO public.assets(id, style_id, name, kind) VALUES (v_asset, v_style, coalesce(nullif(btrim(r->>'name'), ''), 'Untitled'), 'generated');
        INSERT INTO public.asset_versions(id, asset_id, parent_version_id, source, storage_path, mime_type, width, height, byte_size, prompt, provider_response_id, metadata, style_generation)
        VALUES (v_ver, v_asset, (v_job.input->>'source_version_id')::uuid, 'web_openai', r->>'storage_path', r->>'mime_type',
          (r->>'width')::integer, (r->>'height')::integer, (r->>'byte_size')::bigint,
          r->>'prompt', r->>'provider_response_id', r->'metadata', v_job.style_generation);
        UPDATE public.assets SET current_version_id = v_ver, updated_at = now() WHERE id = v_asset;
      END IF;
    ELSE
      -- Legacy project behavior
      v_project := v_job.project_id; v_style := (v_job.input->>'style_id')::uuid;
      IF v_job.operation = 'inpaint' THEN
        IF v_n > 0 OR v_asset <> v_job.asset_id
           OR NOT EXISTS (SELECT 1 FROM public.asset_versions WHERE id = v_job.parent_version_id AND asset_id = v_asset)
        THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
        INSERT INTO public.asset_versions(id, asset_id, parent_version_id, source, storage_path, mime_type, width, height, byte_size, prompt, provider_response_id, metadata)
        VALUES (v_ver, v_asset, v_job.parent_version_id, 'web_openai', r->>'storage_path', r->>'mime_type',
          (r->>'width')::integer, (r->>'height')::integer, (r->>'byte_size')::bigint,
          r->>'prompt', r->>'provider_response_id', r->'metadata');
        UPDATE public.assets SET current_version_id = v_ver, name = coalesce(nullif(btrim(r->>'name'), ''), name), updated_at = now() WHERE id = v_asset;
      ELSE
        IF v_project IS NULL OR NOT EXISTS (SELECT 1 FROM public.projects WHERE id = v_project AND workspace_id = v_job.workspace_id) THEN
          RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002';
        END IF;
        v_kind := 'generated';
        IF v_style IS NOT NULL THEN
          IF NOT EXISTS (SELECT 1 FROM public.styles WHERE id = v_style AND workspace_id = v_job.workspace_id AND status = 'active') THEN
            RAISE EXCEPTION 'STYLE_NOT_ACTIVE' USING errcode = 'P0002';
          END IF;
        END IF;
        INSERT INTO public.assets(id, project_id, name, kind) VALUES (v_asset, v_project, coalesce(nullif(btrim(r->>'name'), ''), 'Untitled'), v_kind);
        INSERT INTO public.asset_versions(id, asset_id, source, storage_path, mime_type, width, height, byte_size, prompt, provider_response_id, metadata)
        VALUES (v_ver, v_asset, 'web_openai', r->>'storage_path', r->>'mime_type',
          (r->>'width')::integer, (r->>'height')::integer, (r->>'byte_size')::bigint,
          r->>'prompt', r->>'provider_response_id', r->'metadata');
        UPDATE public.assets SET current_version_id = v_ver, updated_at = now() WHERE id = v_asset;
      END IF;
    END IF;
    v_n := v_n + 1;
  END LOOP;

  UPDATE public.ai_jobs SET
    status = 'succeeded',
    asset_id = (p_results->0->>'asset_id')::uuid,
    version_id = (p_results->0->>'version_id')::uuid,
    provider_request_id = p_provider_request_id,
    provider_status = p_provider_status,
    output = coalesce(p_output, '{}'::jsonb) || jsonb_build_object('results',
      coalesce((SELECT jsonb_agg(jsonb_build_object('asset_id', x->>'asset_id', 'version_id', x->>'version_id', 'storage_path', x->>'storage_path'))
        FROM jsonb_array_elements(p_results) x), '[]'::jsonb)),
    lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, error_message = NULL,
    completed_at = now(), updated_at = now()
  WHERE id = p_job_id RETURNING * INTO v_job;

  RETURN v_job;
END; $$;

REVOKE ALL ON FUNCTION public.complete_ai_job_with_results(uuid, text, text, text, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_ai_job_with_results(uuid, text, text, text, jsonb, jsonb) TO service_role;

-- 8. Delete guards: block deletion when jobs active
CREATE OR REPLACE FUNCTION public.block_active_job_refs_on_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ai_jobs WHERE style_id = OLD.id AND NOT status IN ('succeeded','failed','canceled')) THEN
    RAISE EXCEPTION 'STYLE_IN_USE' USING errcode = '23503';
  END IF;
  RETURN OLD;
END; $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'block_active_job_refs_on_styles_delete') THEN
    CREATE TRIGGER block_active_job_refs_on_styles_delete
      BEFORE DELETE ON public.styles
      FOR EACH ROW EXECUTE FUNCTION public.block_active_job_refs_on_delete();
  END IF;
END $$;

-- 9. Upload source: extend commit_style_source for uploaded evaluation inputs
-- (No schema change needed; existing RPC already handles style-owned assets)

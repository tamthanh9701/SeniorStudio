-- 0049_storage_path_ownership.sql
-- Deleting a style handed the service role every storage_path recorded on the
-- style's rows. Those rows are written through PostgREST by workspace members,
-- and the only path invariant was "the row's own asset id appears somewhere in
-- the path" (validate_asset_version_path), so a member could point a version at
-- any object key and have the service role delete it. A proof of concept
-- destroyed an unrelated object this way.
--
-- Two layers close it here: the aggregate that feeds the privileged delete only
-- collects paths under the style's own container, and the path invariant now
-- requires the path to live under the owning workspace and project/style. The
-- routes filter again before removing (see src/lib/assets/ownership.ts).
-- 0001-0048 remain immutable.

CREATE OR REPLACE FUNCTION public.validate_asset_version_path() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_project uuid; v_style uuid; v_workspace uuid; v_expected text;
BEGIN
  -- The object key is a claim made by whoever wrote the row; it must agree with
  -- the asset the row belongs to, not merely contain its id.
  SELECT a.project_id, a.style_id, coalesce(p.workspace_id, s.workspace_id)
    INTO v_project, v_style, v_workspace
    FROM public.assets a
    LEFT JOIN public.projects p ON p.id = a.project_id
    LEFT JOIN public.styles s ON s.id = a.style_id
    WHERE a.id = new.asset_id;
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'INVALID_STORAGE_PATH' USING errcode = '22023';
  END IF;
  IF v_style IS NOT NULL THEN
    v_expected := v_workspace::text || '/styles/' || v_style::text || '/';
  ELSE
    v_expected := v_workspace::text || '/' || v_project::text || '/';
  END IF;
  IF new.storage_path NOT LIKE v_expected || '%' THEN
    RAISE EXCEPTION 'INVALID_STORAGE_PATH' USING errcode = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM unnest(string_to_array(trim(both '/' from new.storage_path),'/')) s WHERE s = new.asset_id::text) THEN
    RAISE EXCEPTION 'INVALID_STORAGE_PATH' USING errcode = '22023';
  END IF;
  IF new.mime_type NOT IN ('image/png','image/jpeg','image/webp') OR new.width <= 0 OR new.height <= 0 OR new.byte_size <= 0 OR new.byte_size > 52428800 THEN
    RAISE EXCEPTION 'UNSUPPORTED_IMAGE' USING errcode = '22023';
  END IF;
  RETURN new;
END; $$;

CREATE OR REPLACE FUNCTION public.delete_style_hard(p_style_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_style public.styles; v_job record; v_images integer; v_references integer; v_jobs integer; v_paths text[];
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT * INTO v_style FROM public.styles
    WHERE id = p_style_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF v_style.id IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM public.ai_jobs WHERE style_id = p_style_id
             AND status IN ('queued','submitting','processing','persisting')) THEN
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

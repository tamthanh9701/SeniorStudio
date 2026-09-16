-- 0043_style_hard_delete.sql
-- "Delete style" always failed for any style that had ever generated: ai_jobs.style_id
-- and ai_job_inputs.style_id are NO ACTION FKs, so the styles row delete raised
-- 23503 while every other child (assets, asset_versions, style_references,
-- style_proposals, style_schema_versions) cascaded. 0036 tried to add the cascade
-- but "ADD COLUMN IF NOT EXISTS" skipped it because 0035 had already created the
-- column, so the FK is still NO ACTION.
--
-- Deleting is now one transaction behind an RPC: the route cannot delete the style
-- row itself because the jobs must go first, and unused inpaint masks (rows with
-- style_id and job_id IS NULL) must go too or they keep blocking the delete.
-- Non-terminal jobs still refuse the delete (STYLE_BUSY): the worker holds a lease
-- and would keep uploading objects for a style that no longer exists.
-- Reservation accounting is released through an internal helper because
-- release_ai_reservation() is service-role gated and this RPC runs as the user.
-- 0001-0042 remain immutable.

-- Internal release, same accounting as 0034 without the JWT-role branch: called by
-- SECURITY DEFINER RPCs that run under the caller's request role.
CREATE OR REPLACE FUNCTION public.release_ai_reservation_internal(p_reservation_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.ai_quota_reservations;
BEGIN
  IF p_reservation_id IS NULL THEN RETURN; END IF;
  SELECT * INTO r FROM public.ai_quota_reservations WHERE id = p_reservation_id AND state = 'reserved' FOR UPDATE;
  IF r.id IS NULL THEN RETURN; END IF;
  UPDATE public.ai_quota_reservations SET state = 'released' WHERE id = r.id;
  UPDATE public.workspace_ai_usage SET held = greatest(0, held - r.units)
    WHERE workspace_id = r.workspace_id AND day = r.day AND route_group = r.route_group;
END; $$;
REVOKE ALL ON FUNCTION public.release_ai_reservation_internal(uuid) FROM public, anon, authenticated;

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
  SELECT coalesce(array_agg(DISTINCT path), '{}'::text[]) INTO v_paths FROM (
    SELECT sr.storage_path AS path FROM public.style_references sr WHERE sr.style_id = p_style_id
    UNION ALL
    SELECT av.storage_path FROM public.asset_versions av JOIN public.assets a ON a.id = av.asset_id WHERE a.style_id = p_style_id
    UNION ALL
    SELECT ji.storage_path FROM public.ai_job_inputs ji WHERE ji.style_id = p_style_id
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

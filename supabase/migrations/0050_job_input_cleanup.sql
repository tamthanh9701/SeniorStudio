-- 0050_job_input_cleanup.sql
-- Two leaks around inpaint masks and around uploads kept after an ambiguous
-- persistence commit.
--
-- 1. ai_job_inputs rows are inserted with a one-hour expiry, but nothing ever
--    deleted the expired ones: an abandoned editor tab, a failed enqueue or a
--    job that died by lease expiry left the row AND its Storage object forever.
--    Production had four input rows, all expired, one of them attached to a job
--    that the stale-job sweep had already failed.
-- 2. When complete_ai_job_with_results errors and the resolver cannot tell
--    whether the commit landed, the worker keeps the uploaded objects (deleting
--    them could throw away a paid result). Nothing recorded where they were, so
--    a transient failure leaked paid objects with no row.
--
-- The claims are bounded, service-role only, and use SKIP LOCKED so several
-- workers (or the cron and a manual run) never fight over the same rows.
-- 0001-0049 remain immutable.

-- Masks nothing will ever read again: never attached, or attached to a job that
-- already reached a terminal state.
CREATE OR REPLACE FUNCTION public.claim_expired_job_masks(p_limit integer DEFAULT 50)
RETURNS TABLE(id uuid, storage_path text, workspace_id uuid, cause text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501';
  END IF;
  RETURN QUERY
  WITH doomed AS (
    SELECT ji.id,
           CASE WHEN ji.job_id IS NULL THEN 'abandoned' ELSE 'job_terminal' END AS cause
      FROM public.ai_job_inputs ji
      LEFT JOIN public.ai_jobs j ON j.id = ji.job_id
     WHERE (ji.job_id IS NULL AND ji.expires_at < now())
        OR (ji.job_id IS NOT NULL AND j.status IN ('succeeded','failed','canceled'))
     ORDER BY ji.expires_at
     LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
     FOR UPDATE OF ji SKIP LOCKED
  )
  DELETE FROM public.ai_job_inputs target
   USING doomed
   WHERE target.id = doomed.id
  RETURNING target.id, target.storage_path, target.workspace_id, doomed.cause;
END; $$;
REVOKE ALL ON FUNCTION public.claim_expired_job_masks(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_expired_job_masks(integer) TO service_role;

-- Uploaded objects kept after an unreadable persistence outcome, so the sweeper
-- can decide later whether the commit landed.
CREATE OR REPLACE FUNCTION public.record_pending_uploads(p_job_id uuid, p_paths jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501';
  END IF;
  IF p_job_id IS NULL OR jsonb_typeof(p_paths) <> 'array' OR jsonb_array_length(p_paths) = 0 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
  END IF;
  UPDATE public.ai_jobs
     SET output = coalesce(output, '{}'::jsonb) || jsonb_build_object('pending_uploads', p_paths)
   WHERE id = p_job_id;
END; $$;
REVOKE ALL ON FUNCTION public.record_pending_uploads(uuid, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_pending_uploads(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.clear_pending_uploads(p_job_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501';
  END IF;
  UPDATE public.ai_jobs SET output = coalesce(output, '{}'::jsonb) - 'pending_uploads' WHERE id = p_job_id;
END; $$;
REVOKE ALL ON FUNCTION public.clear_pending_uploads(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_pending_uploads(uuid) TO service_role;

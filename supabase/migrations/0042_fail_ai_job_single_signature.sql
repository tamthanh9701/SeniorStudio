-- 0042_fail_ai_job_single_signature.sql
-- 0012 declared fail_ai_job with a fifth, defaulted p_provider_status parameter and
-- 0033 recreated it with four.  PostgreSQL does not replace a function when the
-- signature changes, so both bodies survived and a four-argument named RPC call
-- matched either candidate.  PostgREST answers such a call with
-- PGRST203 "Could not choose the best candidate function", so the worker's failJob
-- threw FAIL_JOB_RPC_ERROR: every failed generation kept its claim state and the user
-- watched "Starting" until the 180s lease expired, when the stale sweep wrote
-- PROVIDER_OUTCOME_UNKNOWN instead of the real error.  Same trap 0022 fixed for the
-- legacy enqueue overload.
-- One signature remains: the four-parameter body the worker calls, which releases the
-- reserved quota.  The dropped overload's provider_status write was a coalesce with
-- the defaulted parameter, so a four-argument call left that column untouched anyway;
-- the message truncation it did carry is kept here.  0001-0041 remain immutable.

CREATE OR REPLACE FUNCTION public.fail_ai_job(
  p_job_id uuid, p_worker_id text, p_error_code text, p_error_message text
) RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.ai_jobs; v_reservation_id uuid;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501';
  END IF;

  SELECT * INTO v_job FROM public.ai_jobs
  WHERE id = p_job_id AND lease_owner = p_worker_id
  FOR UPDATE;

  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'LEASE_NOT_OWNED' USING errcode = '23505';
  END IF;

  IF v_job.status NOT IN ('submitting', 'processing', 'persisting') THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
  END IF;

  -- Release reserved quota if exists
  v_reservation_id := v_job.quota_reservation_id;

  UPDATE public.ai_jobs
  SET status = 'failed',
      error_code = p_error_code,
      error_message = left(p_error_message, 4000),
      lease_owner = null,
      lease_expires_at = null,
      completed_at = now(),
      updated_at = now()
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  PERFORM public.release_ai_reservation(v_reservation_id);

  RETURN v_job;
END; $$;

DROP FUNCTION public.fail_ai_job(uuid, text, text, text, text);
REVOKE ALL ON FUNCTION public.fail_ai_job(uuid, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_ai_job(uuid, text, text, text) TO service_role;

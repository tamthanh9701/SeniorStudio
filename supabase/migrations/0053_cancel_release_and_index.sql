-- 0053_cancel_release_and_index.sql
-- Two defects and one dead index.
--
-- 1. cancel_ai_job (0033) gates on auth.role() = 'authenticated' and then releases
--    through release_ai_reservation(), which is service-role gated, so the release
--    raised 42501 for the very caller the gate allows and every cancel of a queued
--    job failed. 0043 added release_ai_reservation_internal() for exactly this case
--    (delete_style_hard uses it); cancel_ai_job now uses it too.
-- 2. Reservations left behind by jobs that were canceled before the fix are
--    released here, with the matching workspace_ai_usage.held decrement.
-- 3. ai_jobs_pending_uploads_idx was created with the predicate
--    `output ? 'pending_uploads'`, but the sweeper filters with
--    `.not("output->pending_uploads","is",null)`, which the planner cannot match to
--    that predicate: pg_stat_user_indexes reports 0 scans for it. The predicate now
--    matches the query.
--
-- fail_ai_job and expire_stale_ai_jobs still call the gated release; both are
-- service-role only, so that stays correct.

CREATE OR REPLACE FUNCTION public.cancel_ai_job(p_job_id uuid) RETURNS public.ai_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.ai_jobs; v_reservation_id uuid;
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT * INTO v_job FROM public.ai_jobs
    WHERE id = p_job_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF v_job.status <> 'queued' THEN RAISE EXCEPTION 'JOB_NOT_CANCELABLE' USING errcode = 'P0001'; END IF;

  v_reservation_id := v_job.quota_reservation_id;

  UPDATE public.ai_jobs
     SET status = 'canceled', completed_at = now(), updated_at = now(),
         lease_owner = null, lease_expires_at = null
   WHERE id = p_job_id RETURNING * INTO v_job;

  -- Internal helper: this RPC runs under the caller's request role.
  PERFORM public.release_ai_reservation_internal(v_reservation_id);

  RETURN v_job;
END; $$;
REVOKE ALL ON FUNCTION public.cancel_ai_job(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cancel_ai_job(uuid) TO authenticated;

-- Repair 1: a terminal (or deleted) job must not keep holding quota. The LEFT JOIN
-- catches a reservation whose job row is gone, which is what delete_style_hard and
-- the older fixtures left behind. Each reservation is released once.
WITH stuck AS (
  SELECT r.id
    FROM public.ai_quota_reservations r
    LEFT JOIN public.ai_jobs j ON j.id = r.job_id
   WHERE r.state = 'reserved'
     AND (j.id IS NULL OR j.status IN ('canceled', 'failed'))
)
UPDATE public.ai_quota_reservations r SET state = 'released'
  FROM stuck s WHERE r.id = s.id;

-- Repair 2: held means "units reserved and not yet charged or released", so it is
-- recomputed from the reservations rather than decremented by a guess. This also
-- clears drift that no reservation can explain: when this migration was written,
-- 2026-09-15 held 6 against 6 reserved units and 2026-09-16 held 6 against 4,
-- because fixtures released reservations without touching usage
-- (/tmp/fixture-0043.mjs:128).
UPDATE public.workspace_ai_usage u
   SET held = coalesce((
     SELECT sum(r.units) FROM public.ai_quota_reservations r
      WHERE r.workspace_id = u.workspace_id AND r.day = u.day
        AND r.route_group = u.route_group AND r.state = 'reserved'), 0);

DROP INDEX IF EXISTS public.ai_jobs_pending_uploads_idx;
CREATE INDEX IF NOT EXISTS ai_jobs_pending_uploads_idx
  ON public.ai_jobs (updated_at) WHERE (output -> 'pending_uploads') IS NOT NULL;

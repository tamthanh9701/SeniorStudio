-- 0054_tenant_isolation_and_guards.sql
-- Six findings from the 2026-09-17 review, all of them authorization or accounting
-- holes in the database layer.
--
-- 1. handle_new_user() joined every new account to the FIRST workspace in the
--    database. With email signups enabled on the project (disable_signup was false),
--    any stranger who registered became a member of the production tenant and could
--    then read its styles, jobs, usage and provider API key through RLS - reproduced
--    against the live project before this migration. A new account now always gets a
--    workspace of its own; an email that already has a membership row is left alone
--    (never moved, never joined). Signups were also disabled on the project itself.
-- 2. assets.current_version_id is member-writable and was only checked by its foreign
--    key, so a member could point their own asset at another workspace's version and
--    have the service role sign or delete that object (the sources route and the MCP
--    asset tools read it). A trigger now requires the version to belong to the asset.
-- 3. begin_ai_job_provider() accepted any lease owner without checking that the lease
--    had not expired, so a stale worker could still start paid provider work;
--    renew_ai_job_lease() accepted any lease length, so a worker could park a job
--    outside the 30-600 s window the claim path enforces.
-- 4. set_ai_job_processing(), set_ai_job_persisting() and
--    complete_ai_job_with_results() could be driven without begin_ai_job_provider(),
--    which is the only transition that records the charge: a job could be completed
--    while its reservation stayed `reserved`. They now require the linked reservation
--    to be charged.
-- 5. enqueue_text_to_image_job_v2()/enqueue_image_to_image_job_v2() reserved quota for
--    a caller-supplied workspace BEFORE the guarded enqueue rejected the caller. The
--    reservation only survived because PostgREST rolls the statement back, but the
--    ordering let any authenticated caller take row locks on another workspace's quota
--    rows; the reserve now happens after the authorization check.
-- 6. get_ai_quota_status() was executable by anon and took the workspace id as a
--    parameter: an unauthenticated caller could read any workspace's limits and usage
--    (confirmed live). It is revoked from anon and now requires membership or the
--    service role. provider_settings.api_key is revoked from authenticated - handlers
--    read it with the service role - and storage.buckets gains the size and mime
--    bounds the app already enforces. TRUNCATE/REFERENCES/TRIGGER are revoked from
--    anon and authenticated: row-level security does not apply to TRUNCATE.
-- 0001-0053 remain immutable.

-- 1. Every account gets its own workspace; the tenant is never joined implicitly.
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_workspace_id uuid;
  v_email text := lower(trim(coalesce(new.email, new.id::text)));
BEGIN
  BEGIN
    INSERT INTO public.workspaces(name)
      VALUES (coalesce(nullif(trim(new.email), ''), 'Workspace'))
      RETURNING id INTO v_workspace_id;
    INSERT INTO public.workspace_members(workspace_id, email, supabase_user_id)
      VALUES (v_workspace_id, v_email, new.id);
    INSERT INTO public.workspace_ai_limits(workspace_id) VALUES (v_workspace_id)
      ON CONFLICT (workspace_id) DO NOTHING;
  EXCEPTION WHEN unique_violation THEN
    -- This email already owns a membership row somewhere: leave it where it is. The
    -- subtransaction rolls the workspace insert back, so nothing is left behind.
    RETURN new;
  END;
  RETURN new;
END; $$;

-- 2. A current version must belong to the asset that points at it.
CREATE OR REPLACE FUNCTION public.validate_asset_current_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF new.current_version_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.asset_versions v WHERE v.id = new.current_version_id AND v.asset_id = new.id) THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000';
  END IF;
  RETURN new;
END; $$;
DROP TRIGGER IF EXISTS validate_asset_current_version_trigger ON public.assets;
CREATE TRIGGER validate_asset_current_version_trigger
  BEFORE INSERT OR UPDATE OF current_version_id ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.validate_asset_current_version();

-- 3a. The lease must be the caller's and unexpired before provider work starts.
CREATE OR REPLACE FUNCTION public.begin_ai_job_provider(p_job_id uuid, p_worker_id text)
RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.ai_jobs; v_reservation_id uuid;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501';
  END IF;

  -- Expiry is an authority boundary: an expired worker must not charge quota.
  v_job := public.assert_ai_job_lease(p_job_id, p_worker_id);

  IF v_job.status <> 'submitting' THEN
    RAISE EXCEPTION 'PROVIDER_ALREADY_STARTED' USING errcode = '22023';
  END IF;

  v_reservation_id := v_job.quota_reservation_id;
  IF v_reservation_id IS NULL THEN
    RAISE EXCEPTION 'NO_QUOTA_RESERVED' USING errcode = '22023';
  END IF;

  PERFORM public.begin_ai_provider(v_reservation_id);

  UPDATE public.ai_jobs
     SET status = 'processing', provider_started_at = now(),
         lease_expires_at = now() + make_interval(secs => 150)
   WHERE id = p_job_id
   RETURNING * INTO v_job;

  RETURN v_job;
END; $$;
REVOKE ALL ON FUNCTION public.begin_ai_job_provider(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_ai_job_provider(uuid, text) TO service_role;

-- 3b. A renewal stays inside the window the claim path enforces.
CREATE OR REPLACE FUNCTION public.renew_ai_job_lease(p_job_id uuid, p_worker_id text, p_lease_seconds integer)
RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.ai_jobs;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501'; END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
  END IF;
  PERFORM public.assert_ai_job_lease(p_job_id, p_worker_id);
  UPDATE public.ai_jobs SET lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
   WHERE id = p_job_id RETURNING * INTO v_job;
  RETURN v_job;
END; $$;
REVOKE ALL ON FUNCTION public.renew_ai_job_lease(uuid, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_ai_job_lease(uuid, text, integer) TO service_role;

-- 4. Reaching `processing`/`persisting` requires a charged reservation, so a job can
--    no longer complete without the charge begin_ai_job_provider() records.
CREATE OR REPLACE FUNCTION public.assert_ai_job_charged(p_job public.ai_jobs) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_job.quota_reservation_id IS NULL THEN RETURN; END IF;
  IF (SELECT state FROM public.ai_quota_reservations WHERE id = p_job.quota_reservation_id) IS DISTINCT FROM 'charged' THEN
    RAISE EXCEPTION 'QUOTA_NOT_CHARGED' USING errcode = '22023';
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.assert_ai_job_charged(public.ai_jobs) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_ai_job_processing(p_job_id uuid, p_worker_id text, p_provider_request_id text, p_provider_status text, p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.ai_jobs;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501'; END IF;
  v_job := public.assert_ai_job_lease(p_job_id, p_worker_id);
  IF v_job.status <> 'processing' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  PERFORM public.assert_ai_job_charged(v_job);
  UPDATE public.ai_jobs
     SET provider_request_id = p_provider_request_id, provider_status = p_provider_status,
         output = output || coalesce(p_metadata, '{}'::jsonb), updated_at = now()
   WHERE id = p_job_id RETURNING * INTO v_job;
  RETURN v_job;
END; $$;
REVOKE ALL ON FUNCTION public.set_ai_job_processing(uuid, text, text, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_ai_job_processing(uuid, text, text, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.set_ai_job_persisting(p_job_id uuid, p_worker_id text)
RETURNS public.ai_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.ai_jobs;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501'; END IF;
  v_job := public.assert_ai_job_lease(p_job_id, p_worker_id);
  IF v_job.status <> 'processing' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  PERFORM public.assert_ai_job_charged(v_job);
  UPDATE public.ai_jobs SET status = 'persisting', updated_at = now()
   WHERE id = p_job_id RETURNING * INTO v_job;
  RETURN v_job;
END; $$;
REVOKE ALL ON FUNCTION public.set_ai_job_persisting(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_ai_job_persisting(uuid, text) TO service_role;

-- 5. Authorize first, reserve second. The bodies below are the live definitions with
--    only the reserve statement moved after the guarded enqueue; CREATE OR REPLACE keeps
--    the existing grants.
CREATE OR REPLACE FUNCTION public.enqueue_text_to_image_job_v2(p_workspace_id uuid, p_project_id uuid, p_requested_by uuid, p_provider text, p_model text, p_prompt text, p_count integer, p_size text, p_quality text, p_style_id uuid DEFAULT NULL::uuid, p_original_prompt text DEFAULT NULL::text, p_module text DEFAULT 'projects'::text, p_cost_mode text DEFAULT NULL::text, p_requested_model_id text DEFAULT NULL::text, p_reference_ids uuid[] DEFAULT '{}'::uuid[], p_temperature numeric DEFAULT NULL::numeric)
 RETURNS ai_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_reservation_id uuid; v_job public.ai_jobs;
begin
  -- The guarded enqueue rejects a caller who does not own p_workspace_id, and nothing
  -- may touch that workspace's quota rows before it has.
  v_job := public.enqueue_text_to_image_job(
    p_workspace_id,p_project_id,p_requested_by,p_provider,p_model,p_prompt,p_count,p_size,
    p_quality,p_style_id,p_original_prompt,p_module,p_cost_mode,p_requested_model_id,
    p_reference_ids,p_temperature);
  v_reservation_id := public.reserve_ai_quota_internal(p_workspace_id,'image',p_count);
  return public.attach_ai_quota_reservation_internal(v_job.id,v_reservation_id);
end; $function$;

CREATE OR REPLACE FUNCTION public.enqueue_image_to_image_job_v2(p_workspace_id uuid, p_requested_by uuid, p_provider text, p_model text, p_prompt text, p_count integer, p_size text, p_quality text, p_style_id uuid, p_source_version_id uuid, p_original_prompt text DEFAULT NULL::text, p_cost_mode text DEFAULT 'strict_style'::text, p_requested_model_id text DEFAULT NULL::text, p_reference_ids uuid[] DEFAULT '{}'::uuid[], p_temperature numeric DEFAULT NULL::numeric)
 RETURNS ai_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_reservation_id uuid; v_job public.ai_jobs;
begin
  v_job := public.enqueue_image_to_image_job(
    p_workspace_id,p_requested_by,p_provider,p_model,p_prompt,p_count,p_size,p_quality,
    p_style_id,p_source_version_id,p_original_prompt,p_cost_mode,p_requested_model_id,
    p_reference_ids,p_temperature);
  v_reservation_id := public.reserve_ai_quota_internal(p_workspace_id,'image',p_count);
  return public.attach_ai_quota_reservation_internal(v_job.id,v_reservation_id);
end; $function$;

-- 4b. Belt for the same invariant: no job may become `succeeded` while its
--     reservation is still reserved, whichever function performs the update.
CREATE OR REPLACE FUNCTION public.validate_ai_job_terminal_charge() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF new.status = 'succeeded' AND old.status IS DISTINCT FROM 'succeeded' THEN
    PERFORM public.assert_ai_job_charged(new);
  END IF;
  RETURN new;
END; $$;
DROP TRIGGER IF EXISTS validate_ai_job_terminal_charge_trigger ON public.ai_jobs;
CREATE TRIGGER validate_ai_job_terminal_charge_trigger
  BEFORE UPDATE ON public.ai_jobs
  FOR EACH ROW EXECUTE FUNCTION public.validate_ai_job_terminal_charge();

-- 6a. Quota status is for the workspace's own members, or the service role.
CREATE OR REPLACE FUNCTION public.get_ai_quota_status(p_workspace_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_day date := (now() at time zone 'utc')::date;
BEGIN
  IF auth.role() <> 'service_role' AND p_workspace_id NOT IN (SELECT public.current_workspace_ids()) THEN
    RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002';
  END IF;
  RETURN jsonb_build_object(
    'day', v_day,
    'image', jsonb_build_object(
      'limit', coalesce((select image_limit from public.workspace_ai_limits where workspace_id = p_workspace_id), 100),
      'held', coalesce((select held from public.workspace_ai_usage where workspace_id = p_workspace_id and day = v_day and route_group = 'image'), 0),
      'charged', coalesce((select charged from public.workspace_ai_usage where workspace_id = p_workspace_id and day = v_day and route_group = 'image'), 0)
    ),
    'brain', jsonb_build_object(
      'limit', coalesce((select brain_limit from public.workspace_ai_limits where workspace_id = p_workspace_id), 200),
      'held', coalesce((select held from public.workspace_ai_usage where workspace_id = p_workspace_id and day = v_day and route_group = 'brain'), 0),
      'charged', coalesce((select charged from public.workspace_ai_usage where workspace_id = p_workspace_id and day = v_day and route_group = 'brain'), 0)
    )
  );
END; $$;
REVOKE ALL ON FUNCTION public.get_ai_quota_status(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_ai_quota_status(uuid) TO authenticated, service_role;

-- 6b. Provider keys are written by members but never read by them: handlers resolve the
-- key with the service role after they have authorized the caller.
REVOKE SELECT ON public.provider_settings FROM anon, authenticated;
GRANT SELECT (id, workspace_id, provider, created_at, updated_at) ON public.provider_settings TO authenticated;

-- 6c. The apply route updates applied_at as the caller; give members that path.
DROP POLICY IF EXISTS "Users can update style proposals in their workspace" ON public.style_proposals;
CREATE POLICY "Users can update style proposals in their workspace" ON public.style_proposals
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.styles s WHERE s.id = style_proposals.style_id AND s.workspace_id IN (SELECT public.current_workspace_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.styles s WHERE s.id = style_proposals.style_id AND s.workspace_id IN (SELECT public.current_workspace_ids())));

-- 6d. The bucket keeps the bounds the application already enforces.
UPDATE storage.buckets
   SET file_size_limit = 52428800,
       allowed_mime_types = ARRAY['image/png','image/jpeg','image/webp']
 WHERE id = 'assets';

-- 6e. Row-level security does not cover TRUNCATE, and no client needs these.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon, authenticated;

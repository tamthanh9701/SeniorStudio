-- 0059_helper_function_grants.sql
-- Validation and guard helpers were reachable by anon and authenticated because
-- PostgreSQL grants EXECUTE on a new function to PUBLIC. None of them reads data, so
-- this is containment rather than a defect fix: a client has no reason to be able to
-- call a packet validator, a domain guard or a trigger body directly, and each one is
-- only ever invoked from a SECURITY DEFINER function that runs as the owner.
--
-- Triggers are unaffected: the EXECUTE privilege is checked when a trigger is created,
-- not when it fires. Functions an API role legitimately calls keep their explicit
-- grants from their own migrations (0054-0058 revoke and grant per function).
-- 0001-0058 remain immutable.

REVOKE ALL ON FUNCTION public.is_supported_model(text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_game_ui_spec(jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_game_ui_document(jsonb, uuid, uuid, integer, integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_game_ui_style_schema(jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_game_ui_kind(text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_game_ui_uuid(text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_game_ui_style_jobs() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_style_domain_write() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_asset_current_version() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_ai_job_terminal_charge() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM public, anon, authenticated;

-- 0021 added style provenance as two trailing defaulted parameters. PostgreSQL
-- treats that as a new overload, not a replacement; keeping the 13-argument
-- overload makes named RPC calls that omit style fields ambiguous in PostgREST.
drop function if exists public.enqueue_ai_job(
  uuid, uuid, uuid, text, text, text, text, integer, text, text, uuid, uuid, text
);

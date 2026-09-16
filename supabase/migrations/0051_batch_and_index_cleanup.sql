-- 0051_batch_and_index_cleanup.sql
-- Two leftovers that make deletion fragile or writes more expensive than they
-- need to be.
--
-- 1. batch_items kept plain NO ACTION foreign keys to ai_jobs and
--    asset_versions. Deleting a job (a style hard delete, or a project delete
--    cascading into its jobs) therefore fails with 23503 whenever a batch item
--    pointed at it, which is the same fault that made "delete style" fail before
--    0043 - just waiting for the batch feature to be used again. A batch slot is
--    a historical record, so it keeps its row and loses the link instead.
-- 2. style_references carried three overlapping indexes on style_id: the plain
--    one, a partial one for live rows, and the ordered partial one added by 0048.
--    The unique (style_id, storage_path) index already serves lookups by style
--    alone, and the ordered partial index serves the live, oldest-first listing,
--    so the first two only cost writes.
-- 0001-0050 remain immutable.

ALTER TABLE public.batch_items DROP CONSTRAINT IF EXISTS batch_items_generation_run_id_fkey;
ALTER TABLE public.batch_items
  ADD CONSTRAINT batch_items_generation_run_id_fkey
  FOREIGN KEY (ai_job_id) REFERENCES public.ai_jobs(id) ON DELETE SET NULL;

ALTER TABLE public.batch_items DROP CONSTRAINT IF EXISTS batch_items_parent_version_id_fkey;
ALTER TABLE public.batch_items
  ADD CONSTRAINT batch_items_parent_version_id_fkey
  FOREIGN KEY (parent_version_id) REFERENCES public.asset_versions(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS public.style_references_style_idx;
DROP INDEX IF EXISTS public.style_references_live_idx;

-- The worker cron runs every five seconds and asks which jobs still carry kept
-- uploads; without this the question is a sequential scan of ai_jobs each tick.
CREATE INDEX IF NOT EXISTS ai_jobs_pending_uploads_idx ON public.ai_jobs (updated_at) WHERE output ? 'pending_uploads';

-- 0048_perf_indexes.sql
-- Three read paths that ran as sequential scans: the version list of an asset
-- (asset detail and gallery), the asset list of a project (playground grid) and
-- the live reference list of a style (workspace, plan and analysis). Each index
-- matches the filter plus the order the query asks for.
-- 0001-0047 remain immutable.

CREATE INDEX IF NOT EXISTS asset_versions_asset_id_created_idx ON public.asset_versions (asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS assets_project_id_created_idx ON public.assets (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS style_references_style_created_idx ON public.style_references (style_id, created_at) WHERE retired_at IS NULL;

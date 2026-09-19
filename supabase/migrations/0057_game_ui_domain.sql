-- 0057_game_ui_domain.sql
-- Game UI Style: a second style domain whose confirmed definition describes
-- screen components (bars, buttons, panels) instead of a scene subject, plus the
-- durable screen, render, element-map and element-output records that follow from
-- it.
--
-- Two shapes are new and both are enforced in SQL, not only in routes: an element
-- map's parent chain must exist, contain its child and never loop, and a Game UI
-- confirmed definition carries definition_version 2 so the generic visual
-- definition (version 1) keeps parsing exactly as before.
-- 0001-0056 remain immutable.

-- ---------------------------------------------------------------------------
-- 1. Style domain
-- ---------------------------------------------------------------------------

ALTER TABLE public.styles ADD COLUMN IF NOT EXISTS domain text NOT NULL DEFAULT 'visual';
ALTER TABLE public.styles DROP CONSTRAINT IF EXISTS styles_domain_check;
ALTER TABLE public.styles ADD CONSTRAINT styles_domain_check CHECK (domain IN ('visual','game_ui'));
CREATE INDEX IF NOT EXISTS styles_domain_idx ON public.styles(workspace_id, domain, created_at DESC, id);

-- The domain decides how schema, fingerprint and confirmed_definition are read,
-- so it must not change under existing rows: a style that flipped domains would
-- silently reinterpret its own history.
CREATE OR REPLACE FUNCTION public.guard_style_domain_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.domain IS DISTINCT FROM OLD.domain THEN
    RAISE EXCEPTION 'STYLE_DOMAIN_IMMUTABLE' USING errcode = '42501';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS styles_guard_domain_trigger ON public.styles;
CREATE TRIGGER styles_guard_domain_trigger BEFORE UPDATE ON public.styles
FOR EACH ROW EXECUTE FUNCTION public.guard_style_domain_write();

-- ---------------------------------------------------------------------------
-- 2. Screen, render, element map, input and output records
-- ---------------------------------------------------------------------------

-- One screen draft: the description, the requirement list and the optional
-- wireframe that generation is planned from.  A render freezes a copy of it, so
-- editing a draft never reinterprets an image that was already generated.
CREATE TABLE IF NOT EXISTS public.game_ui_screens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  style_id uuid NOT NULL REFERENCES public.styles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  draft_spec jsonb NOT NULL,
  draft_revision bigint NOT NULL DEFAULT 1 CHECK (draft_revision >= 1),
  wireframe_version_id uuid REFERENCES public.asset_versions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS game_ui_screens_style_idx ON public.game_ui_screens(workspace_id, style_id, created_at DESC, id);

-- One generated screen image.  Created only by job completion, never by a route,
-- so every render is backed by a real succeeded job and an immutable version.
CREATE TABLE IF NOT EXISTS public.game_ui_renders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  style_id uuid NOT NULL REFERENCES public.styles(id) ON DELETE CASCADE,
  screen_id uuid NOT NULL REFERENCES public.game_ui_screens(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.ai_jobs(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES public.assets(id) ON DELETE RESTRICT,
  version_id uuid NOT NULL UNIQUE REFERENCES public.asset_versions(id) ON DELETE RESTRICT,
  spec_snapshot jsonb NOT NULL,
  style_revision uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS game_ui_renders_screen_idx ON public.game_ui_renders(workspace_id, screen_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS game_ui_renders_job_idx ON public.game_ui_renders(job_id);

-- Append-only element-map revisions.  The newest revision of a render is
-- authoritative; older revisions stay because stored outputs name the revision
-- they were extracted from.
CREATE TABLE IF NOT EXISTS public.game_ui_element_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  render_id uuid NOT NULL REFERENCES public.game_ui_renders(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision >= 1),
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (render_id, revision)
);
CREATE INDEX IF NOT EXISTS game_ui_element_sets_render_idx ON public.game_ui_element_sets(render_id, revision DESC);

-- Wireframe and foreground-matte bytes live in style-owned assets; this row
-- classifies them and, for a matte, pins the render, element-set revision and
-- element it was painted for.
CREATE TABLE IF NOT EXISTS public.game_ui_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  style_id uuid NOT NULL REFERENCES public.styles(id) ON DELETE CASCADE,
  version_id uuid NOT NULL UNIQUE REFERENCES public.asset_versions(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('wireframe','element_matte')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  render_id uuid REFERENCES public.game_ui_renders(id) ON DELETE CASCADE,
  element_set_id uuid REFERENCES public.game_ui_element_sets(id) ON DELETE CASCADE,
  element_id uuid,
  width integer NOT NULL CHECK (width BETWEEN 1 AND 20000),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_ui_inputs_kind_shape_check CHECK (
    (kind = 'wireframe' AND render_id IS NULL AND element_set_id IS NULL AND element_id IS NULL)
    OR (kind = 'element_matte' AND render_id IS NOT NULL AND element_set_id IS NOT NULL AND element_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS game_ui_inputs_style_idx ON public.game_ui_inputs(workspace_id, style_id, kind, created_at DESC);

-- One exported or reconstructed element image.  `mode` records how the pixels
-- were produced, because an extracted crop and a painted reconstruction are not
-- interchangeable and a manifest must say which one it carries.
CREATE TABLE IF NOT EXISTS public.game_ui_element_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  render_id uuid NOT NULL REFERENCES public.game_ui_renders(id) ON DELETE CASCADE,
  element_set_id uuid NOT NULL REFERENCES public.game_ui_element_sets(id) ON DELETE CASCADE,
  element_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('exact','reconstructed')),
  matte_input_id uuid REFERENCES public.game_ui_inputs(id) ON DELETE RESTRICT,
  job_id uuid REFERENCES public.ai_jobs(id) ON DELETE SET NULL,
  asset_id uuid NOT NULL REFERENCES public.assets(id) ON DELETE RESTRICT,
  version_id uuid NOT NULL UNIQUE REFERENCES public.asset_versions(id) ON DELETE RESTRICT,
  alpha_status text NOT NULL CHECK (alpha_status IN ('transparent','opaque')),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','accepted','discarded')),
  source_bounds jsonb NOT NULL,
  provider text,
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_ui_element_outputs_mode_shape_check CHECK (
    (mode = 'exact' AND matte_input_id IS NOT NULL AND job_id IS NULL)
    OR (mode = 'reconstructed' AND matte_input_id IS NULL AND job_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS game_ui_element_outputs_render_idx ON public.game_ui_element_outputs(workspace_id, render_id, created_at DESC);
CREATE INDEX IF NOT EXISTS game_ui_element_outputs_set_idx ON public.game_ui_element_outputs(element_set_id, element_id);

-- Pending uploads: a row exists only while an upload's outcome is unknown.
-- Written before the object is uploaded, removed in the same transaction that
-- commits the input/output, swept when the object is proven uncommitted.
CREATE TABLE IF NOT EXISTS public.game_ui_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  style_id uuid NOT NULL REFERENCES public.styles(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL,
  version_id uuid NOT NULL,
  storage_path text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('wireframe','element_matte','element_output')),
  input_id uuid,
  output_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS game_ui_uploads_age_idx ON public.game_ui_uploads(created_at);
CREATE INDEX IF NOT EXISTS game_ui_uploads_version_idx ON public.game_ui_uploads(version_id);

-- Extracted pixels are produced by this application, not by a provider; the
-- existing source vocabulary said "upload", which would misdescribe them.
ALTER TABLE public.asset_versions DROP CONSTRAINT IF EXISTS asset_versions_source_check;
ALTER TABLE public.asset_versions ADD CONSTRAINT asset_versions_source_check
  CHECK (source IN ('chatgpt','web_openai','upload','flattened','extraction'));

ALTER TABLE public.game_ui_screens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_ui_renders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_ui_element_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_ui_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_ui_element_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_ui_uploads ENABLE ROW LEVEL SECURITY;

-- Read-only for members, like style_references: every write goes through an RPC
-- that proves ownership, CAS revision and domain, so a member cannot rewrite an
-- element map or an output's provenance through PostgREST.
DROP POLICY IF EXISTS "Members read game ui screens" ON public.game_ui_screens;
CREATE POLICY "Members read game ui screens" ON public.game_ui_screens
  FOR SELECT TO authenticated USING (workspace_id IN (SELECT public.current_workspace_ids()));
DROP POLICY IF EXISTS "Members read game ui renders" ON public.game_ui_renders;
CREATE POLICY "Members read game ui renders" ON public.game_ui_renders
  FOR SELECT TO authenticated USING (workspace_id IN (SELECT public.current_workspace_ids()));
DROP POLICY IF EXISTS "Members read game ui element sets" ON public.game_ui_element_sets;
CREATE POLICY "Members read game ui element sets" ON public.game_ui_element_sets
  FOR SELECT TO authenticated USING (workspace_id IN (SELECT public.current_workspace_ids()));
DROP POLICY IF EXISTS "Members read game ui inputs" ON public.game_ui_inputs;
CREATE POLICY "Members read game ui inputs" ON public.game_ui_inputs
  FOR SELECT TO authenticated USING (workspace_id IN (SELECT public.current_workspace_ids()));
DROP POLICY IF EXISTS "Members read game ui element outputs" ON public.game_ui_element_outputs;
CREATE POLICY "Members read game ui element outputs" ON public.game_ui_element_outputs
  FOR SELECT TO authenticated USING (workspace_id IN (SELECT public.current_workspace_ids()));

GRANT SELECT ON public.game_ui_screens, public.game_ui_renders, public.game_ui_element_sets, public.game_ui_inputs, public.game_ui_element_outputs TO authenticated;
GRANT ALL ON public.game_ui_screens, public.game_ui_renders, public.game_ui_element_sets, public.game_ui_inputs, public.game_ui_element_outputs, public.game_ui_uploads TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Validators shared by every write path
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_game_ui_kind(p_kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_kind IN (
    'group','health_bar','resource_bar','progress_bar','bar_track','bar_fill','avatar','icon','button',
    'popup','modal','panel','frame','text','badge','counter','tab','toggle','slider','input','list_item',
    'tooltip','background','decoration','custom')
$$;

CREATE OR REPLACE FUNCTION public.is_game_ui_uuid(p_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_value,'') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

-- Requirement list for one screen draft.
CREATE OR REPLACE FUNCTION public.assert_game_ui_spec(p_spec jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE v_requirement jsonb; v_ids text[] := '{}'; v_id text;
BEGIN
  IF p_spec IS NULL OR jsonb_typeof(p_spec) <> 'object' OR coalesce((p_spec->>'schema_version')::int, 0) <> 1 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
  END IF;
  IF char_length(btrim(coalesce(p_spec->>'name',''))) NOT BETWEEN 1 AND 100
     OR char_length(coalesce(p_spec->>'description','')) > 2000
     OR char_length(coalesce(p_spec->>'layout_notes','')) > 2000 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
  END IF;
  IF jsonb_typeof(p_spec->'requirements') <> 'array' OR jsonb_array_length(p_spec->'requirements') > 100 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
  END IF;
  FOR v_requirement IN SELECT value FROM jsonb_array_elements(p_spec->'requirements') LOOP
    IF jsonb_typeof(v_requirement) <> 'object' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    v_id := v_requirement->>'id';
    IF NOT public.is_game_ui_uuid(v_id) OR v_id = ANY(v_ids) THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    v_ids := v_ids || v_id;
    IF NOT public.is_game_ui_kind(v_requirement->>'kind') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    IF (v_requirement->>'kind') = 'custom' THEN
      IF char_length(btrim(coalesce(v_requirement->>'custom_type',''))) NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    ELSIF coalesce(v_requirement->>'custom_type','') <> '' THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
    END IF;
    IF char_length(btrim(coalesce(v_requirement->>'name',''))) NOT BETWEEN 1 AND 100
       OR char_length(coalesce(v_requirement->>'purpose','')) > 1000
       OR char_length(coalesce(v_requirement->>'visible_text','')) > 500
       OR char_length(coalesce(v_requirement->>'visible_state','')) > 200
       OR jsonb_typeof(v_requirement->'required') <> 'boolean' THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
    END IF;
  END LOOP;
  IF octet_length(p_spec::text) > 262144 THEN RAISE EXCEPTION 'DOCUMENT_TOO_LARGE' USING errcode = '22023'; END IF;
END; $$;

-- The element map: uuid membership, taxonomy, geometry inside the canvas, parent
-- existence/containment and a bounded walk that rejects a cycle.
CREATE OR REPLACE FUNCTION public.assert_game_ui_document(
  p_document jsonb, p_render_id uuid, p_source_version_id uuid, p_width integer, p_height integer
) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v_element jsonb; v_bounds jsonb; v_ids text[] := '{}'; v_id text;
  v_cursor text; v_depth integer; v_x integer; v_y integer; v_w integer; v_h integer;
  v_parent jsonb; v_coverage jsonb; v_element_id text;
BEGIN
  IF p_document IS NULL OR jsonb_typeof(p_document) <> 'object' OR coalesce((p_document->>'schema_version')::int, 0) <> 1 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
  END IF;
  IF (p_document->>'render_id') IS DISTINCT FROM p_render_id::text
     OR (p_document->>'source_version_id') IS DISTINCT FROM p_source_version_id::text THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
  END IF;
  IF jsonb_typeof(p_document->'canvas') <> 'object'
     OR coalesce((p_document->'canvas'->>'width')::int, 0) <> p_width
     OR coalesce((p_document->'canvas'->>'height')::int, 0) <> p_height THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
  END IF;
  IF jsonb_typeof(p_document->'elements') <> 'array' OR jsonb_array_length(p_document->'elements') > 100 THEN
    RAISE EXCEPTION 'TOO_MANY_ELEMENTS' USING errcode = '22023';
  END IF;
  IF jsonb_typeof(p_document->'coverage') <> 'array' OR jsonb_array_length(p_document->'coverage') > 100 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
  END IF;

  FOR v_element IN SELECT value FROM jsonb_array_elements(p_document->'elements') LOOP
    IF jsonb_typeof(v_element) <> 'object' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    v_id := v_element->>'id';
    IF NOT public.is_game_ui_uuid(v_id) OR v_id = ANY(v_ids) THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    v_ids := v_ids || v_id;
    IF NOT public.is_game_ui_kind(v_element->>'kind') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    IF (v_element->>'kind') = 'custom' THEN
      IF char_length(btrim(coalesce(v_element->>'custom_type',''))) NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    ELSIF coalesce(v_element->>'custom_type','') <> '' THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
    END IF;
    IF char_length(btrim(coalesce(v_element->>'name',''))) NOT BETWEEN 1 AND 100
       OR char_length(coalesce(v_element->>'purpose','')) > 1000
       OR char_length(coalesce(v_element->>'visible_text','')) > 500
       OR char_length(coalesce(v_element->>'visible_state','')) > 200
       OR char_length(coalesce(v_element->>'notes','')) > 1000
       OR jsonb_typeof(v_element->'reviewed') <> 'boolean'
       OR jsonb_typeof(v_element->'occluded') <> 'boolean' THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023';
    END IF;
    IF jsonb_typeof(v_element->'z_index') <> 'number' OR ((v_element->>'z_index')::numeric % 1) <> 0 THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    IF jsonb_typeof(v_element->'confidence') NOT IN ('null','number')
       OR (jsonb_typeof(v_element->'confidence') = 'number' AND ((v_element->>'confidence')::numeric < 0 OR (v_element->>'confidence')::numeric > 1)) THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    v_bounds := v_element->'bounds';
    IF jsonb_typeof(v_bounds) <> 'object'
       OR (v_bounds->>'x') !~ '^-?[0-9]+$' OR (v_bounds->>'y') !~ '^-?[0-9]+$'
       OR (v_bounds->>'width') !~ '^-?[0-9]+$' OR (v_bounds->>'height') !~ '^-?[0-9]+$' THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    v_x := (v_bounds->>'x')::int; v_y := (v_bounds->>'y')::int;
    v_w := (v_bounds->>'width')::int; v_h := (v_bounds->>'height')::int;
    IF v_w < 1 OR v_h < 1 OR v_x < 0 OR v_y < 0 OR v_x + v_w > p_width OR v_y + v_h > p_height THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;

    v_cursor := v_element->>'parent_id';
    IF v_cursor IS NOT NULL THEN
      IF NOT public.is_game_ui_uuid(v_cursor) THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
      v_depth := 0;
      WHILE v_cursor IS NOT NULL LOOP
        v_depth := v_depth + 1;
        IF v_depth > 100 OR v_cursor = v_id THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
        SELECT value INTO v_parent FROM jsonb_array_elements(p_document->'elements') WHERE value->>'id' = v_cursor;
        IF v_parent IS NULL THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
        IF v_depth = 1 THEN
          -- The parent's own box is validated on its element turn, so the cast
          -- here must not assume it is numeric yet.
          IF (v_parent->'bounds'->>'x') !~ '^-?[0-9]+$' OR (v_parent->'bounds'->>'y') !~ '^-?[0-9]+$'
             OR (v_parent->'bounds'->>'width') !~ '^-?[0-9]+$' OR (v_parent->'bounds'->>'height') !~ '^-?[0-9]+$' THEN
            RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
          IF (v_parent->'bounds'->>'x')::int > v_x OR (v_parent->'bounds'->>'y')::int > v_y
             OR (v_parent->'bounds'->>'x')::int + (v_parent->'bounds'->>'width')::int < v_x + v_w
             OR (v_parent->'bounds'->>'y')::int + (v_parent->'bounds'->>'height')::int < v_y + v_h THEN
            RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
        END IF;
        v_cursor := v_parent->>'parent_id';
      END LOOP;
    END IF;
  END LOOP;

  FOR v_coverage IN SELECT value FROM jsonb_array_elements(p_document->'coverage') LOOP
    IF jsonb_typeof(v_coverage) <> 'object'
       OR NOT public.is_game_ui_uuid(v_coverage->>'requirement_id')
       OR (v_coverage->>'status') NOT IN ('present','missing','uncertain')
       OR char_length(coalesce(v_coverage->>'note','')) > 500
       OR jsonb_typeof(v_coverage->'element_ids') <> 'array' THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    FOR v_element_id IN SELECT value FROM jsonb_array_elements_text(v_coverage->'element_ids') LOOP
      IF NOT (v_element_id = ANY(v_ids)) THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    END LOOP;
  END LOOP;
  IF octet_length(p_document::text) > 262144 THEN RAISE EXCEPTION 'DOCUMENT_TOO_LARGE' USING errcode = '22023'; END IF;
END; $$;

-- The confirmed Game UI style schema.  This is the durable gate: confirmation,
-- analysis commit and manual schema edits all run it, so an incomplete candidate
-- cannot become a definition even if a route forgot to check.
CREATE OR REPLACE FUNCTION public.assert_game_ui_style_schema(p_schema jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v_entry jsonb; v_ids text[] := '{}'; v_kinds text[] := '{}'; v_id text; v_kind text;
  v_role text;
BEGIN
  IF p_schema IS NULL OR jsonb_typeof(p_schema) <> 'object'
     OR coalesce((p_schema->>'schema_version')::int, 0) <> 1
     OR coalesce(p_schema->>'domain','') <> 'game_ui' THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023';
  END IF;
  IF char_length(btrim(coalesce(p_schema->>'name',''))) NOT BETWEEN 1 AND 100
     OR char_length(btrim(coalesce(p_schema->>'visual_language',''))) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023';
  END IF;

  IF jsonb_typeof(p_schema->'palette') <> 'array' OR jsonb_array_length(p_schema->'palette') NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_schema->'palette') LOOP
    v_id := v_entry->>'id'; v_role := v_entry->>'role';
    IF v_id !~ '^[a-z0-9][a-z0-9-]{0,39}$' OR v_id = ANY(v_ids) THEN
      RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
    v_ids := v_ids || v_id;
    IF v_role NOT IN ('background','surface','primary','secondary','accent','text','muted','success','warning','danger','custom') THEN
      RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
    IF coalesce(v_entry->>'color','') !~ '^#[0-9a-f]{6}([0-9a-f]{2})?$' OR char_length(coalesce(v_entry->>'notes','')) > 500 THEN
      RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
  END LOOP;

  IF jsonb_typeof(p_schema->'typography') <> 'array' OR jsonb_array_length(p_schema->'typography') NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_schema->'typography') LOOP
    IF (v_entry->>'role') NOT IN ('title','heading','body','caption','numeric','button')
       OR (v_entry->>'casing') NOT IN ('unchanged','uppercase','lowercase','title')
       OR char_length(coalesce(v_entry->>'family_description','')) > 1000
       OR char_length(coalesce(v_entry->>'weight','')) > 100
       OR char_length(coalesce(v_entry->>'effects','')) > 500 THEN
      RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
  END LOOP;

  IF jsonb_typeof(p_schema->'layout') <> 'object'
     OR (p_schema->'layout'->>'density') NOT IN ('compact','balanced','spacious')
     OR char_length(coalesce(p_schema->'layout'->>'spacing_rules','')) > 1000
     OR char_length(coalesce(p_schema->'layout'->>'alignment_rules','')) > 1000
     OR char_length(coalesce(p_schema->'layout'->>'safe_area_rules','')) > 1000
     OR char_length(coalesce(p_schema->'layout'->>'hierarchy_rules','')) > 1000 THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
  IF jsonb_typeof(p_schema->'shape') <> 'object'
     OR char_length(coalesce(p_schema->'shape'->>'corner_rules','')) > 1000
     OR char_length(coalesce(p_schema->'shape'->>'border_rules','')) > 1000
     OR char_length(coalesce(p_schema->'shape'->>'silhouette_rules','')) > 1000 THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
  IF jsonb_typeof(p_schema->'surface') <> 'object'
     OR char_length(coalesce(p_schema->'surface'->>'materials','')) > 1000
     OR char_length(coalesce(p_schema->'surface'->>'shading','')) > 1000
     OR char_length(coalesce(p_schema->'surface'->>'shadows','')) > 1000
     OR char_length(coalesce(p_schema->'surface'->>'highlights','')) > 1000 THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
  IF jsonb_typeof(p_schema->'iconography') <> 'object'
     OR char_length(coalesce(p_schema->'iconography'->>'construction','')) > 1000
     OR char_length(coalesce(p_schema->'iconography'->>'stroke_rules','')) > 1000
     OR char_length(coalesce(p_schema->'iconography'->>'detail_level','')) > 1000 THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;

  IF jsonb_typeof(p_schema->'components') <> 'array' OR jsonb_array_length(p_schema->'components') NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_schema->'components') LOOP
    v_kind := v_entry->>'kind';
    IF NOT public.is_game_ui_kind(v_kind) OR v_kind = ANY(v_kinds) THEN
      RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
    v_kinds := v_kinds || v_kind;
    IF char_length(coalesce(v_entry->>'appearance','')) > 1000
       OR char_length(coalesce(v_entry->>'text_rules','')) > 1000
       OR char_length(coalesce(v_entry->>'composition_rules','')) > 1000 THEN
      RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
  END LOOP;

  IF jsonb_typeof(p_schema->'invariants') <> 'array' OR jsonb_array_length(p_schema->'invariants') NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_schema->'invariants') t WHERE char_length(btrim(t.value)) NOT BETWEEN 1 AND 500) THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
  IF jsonb_typeof(p_schema->'avoid') <> 'array' OR jsonb_array_length(p_schema->'avoid') > 30 THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_schema->'avoid') t WHERE char_length(btrim(t.value)) NOT BETWEEN 1 AND 500) THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
  IF jsonb_typeof(p_schema->'uncertainties') <> 'array' OR jsonb_array_length(p_schema->'uncertainties') > 30 THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_schema->'uncertainties') t
      WHERE char_length(btrim(coalesce(t.value->>'field',''))) NOT BETWEEN 1 AND 200
         OR char_length(btrim(coalesce(t.value->>'question',''))) NOT BETWEEN 1 AND 500) THEN
    RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
END; $$;

-- ---------------------------------------------------------------------------
-- 4. Screen and element-map writes
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.save_game_ui_screen(
  p_style_id uuid, p_screen_id uuid, p_expected_revision bigint, p_name text, p_spec jsonb, p_wireframe_version_id uuid
) RETURNS public.game_ui_screens LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_style public.styles; v_screen public.game_ui_screens;
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  -- FOR UPDATE: a style being hard deleted must not gain a screen mid-delete.
  SELECT * INTO v_style FROM public.styles
    WHERE id = p_style_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF v_style.id IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF v_style.domain <> 'game_ui' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  IF p_screen_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  IF char_length(btrim(coalesce(p_name,''))) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  PERFORM public.assert_game_ui_spec(p_spec);
  IF p_wireframe_version_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.game_ui_inputs gi
        WHERE gi.version_id = p_wireframe_version_id AND gi.style_id = p_style_id
          AND gi.workspace_id = v_style.workspace_id AND gi.kind = 'wireframe') THEN
      RAISE EXCEPTION 'INPUT_NOT_FOUND' USING errcode = 'P0002'; END IF;
  END IF;

  IF p_expected_revision = 0 THEN
    IF EXISTS (SELECT 1 FROM public.game_ui_screens WHERE id = p_screen_id) THEN
      RAISE EXCEPTION 'SCREEN_VERSION_CONFLICT' USING errcode = '23000'; END IF;
    INSERT INTO public.game_ui_screens(id, workspace_id, style_id, name, draft_spec, draft_revision, wireframe_version_id)
      VALUES (p_screen_id, v_style.workspace_id, p_style_id, btrim(p_name), p_spec, 1, p_wireframe_version_id)
      RETURNING * INTO v_screen;
    RETURN v_screen;
  END IF;

  SELECT * INTO v_screen FROM public.game_ui_screens
    WHERE id = p_screen_id AND style_id = p_style_id AND workspace_id = v_style.workspace_id FOR UPDATE;
  IF v_screen.id IS NULL THEN RAISE EXCEPTION 'SCREEN_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF v_screen.draft_revision <> p_expected_revision THEN RAISE EXCEPTION 'SCREEN_VERSION_CONFLICT' USING errcode = '23000'; END IF;
  UPDATE public.game_ui_screens
    SET name = btrim(p_name), draft_spec = p_spec, wireframe_version_id = p_wireframe_version_id,
        draft_revision = draft_revision + 1, updated_at = now()
    WHERE id = p_screen_id RETURNING * INTO v_screen;
  RETURN v_screen;
END; $$;
REVOKE ALL ON FUNCTION public.save_game_ui_screen(uuid,uuid,bigint,text,jsonb,uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.save_game_ui_screen(uuid,uuid,bigint,text,jsonb,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.save_game_ui_elements(
  p_render_id uuid, p_expected_revision bigint, p_document jsonb
) RETURNS public.game_ui_element_sets LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_render public.game_ui_renders; v_style public.styles; v_set public.game_ui_element_sets;
        v_width integer; v_height integer;
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  SELECT * INTO v_render FROM public.game_ui_renders
    WHERE id = p_render_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF v_render.id IS NULL THEN RAISE EXCEPTION 'RENDER_NOT_FOUND' USING errcode = 'P0002'; END IF;
  -- The style row is the delete/enqueue serialization point for every Game UI write.
  SELECT * INTO v_style FROM public.styles WHERE id = v_render.style_id FOR SHARE;
  IF v_style.id IS NULL OR v_style.domain <> 'game_ui' THEN RAISE EXCEPTION 'RENDER_NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT av.width, av.height INTO v_width, v_height FROM public.asset_versions av
    WHERE av.id = v_render.version_id AND av.asset_id = v_render.asset_id;
  IF v_width IS NULL THEN RAISE EXCEPTION 'RENDER_NOT_FOUND' USING errcode = 'P0002'; END IF;
  PERFORM public.assert_game_ui_document(p_document, p_render_id, v_render.version_id, v_width, v_height);

  IF p_expected_revision = 0 THEN
    IF EXISTS (SELECT 1 FROM public.game_ui_element_sets WHERE render_id = p_render_id) THEN
      RAISE EXCEPTION 'SCREEN_VERSION_CONFLICT' USING errcode = '23000'; END IF;
    INSERT INTO public.game_ui_element_sets(workspace_id, render_id, revision, document)
      VALUES (v_render.workspace_id, p_render_id, 1, p_document) RETURNING * INTO v_set;
    RETURN v_set;
  END IF;

  SELECT * INTO v_set FROM public.game_ui_element_sets
    WHERE render_id = p_render_id ORDER BY revision DESC LIMIT 1 FOR UPDATE;
  IF v_set.id IS NULL THEN RAISE EXCEPTION 'SCREEN_VERSION_CONFLICT' USING errcode = '23000'; END IF;
  IF v_set.revision <> p_expected_revision THEN RAISE EXCEPTION 'SCREEN_VERSION_CONFLICT' USING errcode = '23000'; END IF;
  INSERT INTO public.game_ui_element_sets(workspace_id, render_id, revision, document)
    VALUES (v_render.workspace_id, p_render_id, p_expected_revision + 1, p_document) RETURNING * INTO v_set;
  RETURN v_set;
END; $$;
REVOKE ALL ON FUNCTION public.save_game_ui_elements(uuid,bigint,jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.save_game_ui_elements(uuid,bigint,jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Pending-upload bookkeeping (service role)
-- ---------------------------------------------------------------------------

-- Written before the object is uploaded, so an ambiguous outcome always leaves a
-- row naming the path.  A committed input/output removes its row in the same
-- transaction, which is why existence of a row means "outcome unknown".
CREATE OR REPLACE FUNCTION public.begin_game_ui_upload(
  p_upload_id uuid, p_workspace_id uuid, p_style_id uuid, p_asset_id uuid, p_version_id uuid,
  p_storage_path text, p_operation text, p_input_id uuid, p_output_id uuid
) RETURNS public.game_ui_uploads LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_upload public.game_ui_uploads;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.styles WHERE id = p_style_id AND workspace_id = p_workspace_id AND domain = 'game_ui') THEN
    RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_operation NOT IN ('wireframe','element_matte','element_output') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  IF coalesce(p_storage_path,'') NOT LIKE p_workspace_id::text || '/styles/' || p_style_id::text || '/%' THEN
    RAISE EXCEPTION 'INVALID_STORAGE_PATH' USING errcode = '22023'; END IF;
  INSERT INTO public.game_ui_uploads(id, workspace_id, style_id, asset_id, version_id, storage_path, operation, input_id, output_id)
    VALUES (p_upload_id, p_workspace_id, p_style_id, p_asset_id, p_version_id, p_storage_path, p_operation, p_input_id, p_output_id)
    ON CONFLICT (id) DO NOTHING;
  SELECT * INTO v_upload FROM public.game_ui_uploads WHERE id = p_upload_id;
  IF v_upload.storage_path IS DISTINCT FROM p_storage_path THEN RAISE EXCEPTION 'CONFLICT' USING errcode = '23000'; END IF;
  RETURN v_upload;
END; $$;
REVOKE ALL ON FUNCTION public.begin_game_ui_upload(uuid,uuid,uuid,uuid,uuid,text,text,uuid,uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_game_ui_upload(uuid,uuid,uuid,uuid,uuid,text,text,uuid,uuid) TO service_role;

-- Sweeper input: uploads older than an hour plus whether their outcome is now
-- committed.  A committed outcome means only the bookkeeping row is stale; an
-- uncommitted one means the object is an orphan the route may remove.
CREATE OR REPLACE FUNCTION public.claim_expired_game_ui_uploads(p_limit integer DEFAULT 20)
RETURNS TABLE(id uuid, workspace_id uuid, style_id uuid, storage_path text, operation text, version_id uuid, committed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501'; END IF;
  RETURN QUERY
    SELECT u.id, u.workspace_id, u.style_id, u.storage_path, u.operation, u.version_id,
           (EXISTS (SELECT 1 FROM public.game_ui_inputs gi WHERE gi.version_id = u.version_id)
            OR EXISTS (SELECT 1 FROM public.game_ui_element_outputs go WHERE go.version_id = u.version_id)
            OR EXISTS (SELECT 1 FROM public.asset_versions av WHERE av.id = u.version_id)) AS committed
      FROM public.game_ui_uploads u
     WHERE u.created_at < now() - interval '1 hour'
     ORDER BY u.created_at
     LIMIT greatest(1, least(coalesce(p_limit, 20), 100));
END; $$;
REVOKE ALL ON FUNCTION public.claim_expired_game_ui_uploads(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_expired_game_ui_uploads(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_game_ui_upload(p_upload_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501'; END IF;
  DELETE FROM public.game_ui_uploads WHERE id = p_upload_id;
END; $$;
REVOKE ALL ON FUNCTION public.finish_game_ui_upload(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_game_ui_upload(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Input and output commits (service role)
-- ---------------------------------------------------------------------------

-- Registers wireframe or matte bytes: style-owned asset + version + classified
-- input row in one transaction, so no object is reachable without its meaning.
CREATE OR REPLACE FUNCTION public.register_game_ui_input(
  p_workspace_id uuid, p_style_id uuid, p_asset_id uuid, p_version_id uuid, p_input_id uuid,
  p_kind text, p_file jsonb, p_context jsonb
) RETURNS public.game_ui_inputs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_input public.game_ui_inputs; v_render public.game_ui_renders; v_set public.game_ui_element_sets;
  v_element jsonb; v_path text; v_mime text; v_ext text; v_width integer; v_height integer; v_bytes bigint;
  v_hash text; v_name text; v_render_id uuid; v_set_id uuid; v_element_id uuid; v_bounds jsonb;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.styles WHERE id = p_style_id AND workspace_id = p_workspace_id AND domain = 'game_ui') THEN
    RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_kind NOT IN ('wireframe','element_matte') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  IF p_file IS NULL OR jsonb_typeof(p_file) <> 'object' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  v_path := coalesce(p_file->>'storage_path',''); v_mime := coalesce(p_file->>'mime_type','');
  v_hash := coalesce(p_file->>'content_hash',''); v_name := coalesce(p_file->>'name','');
  v_bytes := coalesce((p_file->>'byte_size')::bigint, 0);
  v_width := coalesce((p_file->>'width')::integer, 0); v_height := coalesce((p_file->>'height')::integer, 0);
  IF (p_file->>'width') !~ '^[0-9]+$' OR (p_file->>'height') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  IF v_width NOT BETWEEN 1 AND 20000 OR v_height NOT BETWEEN 1 AND 20000 THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  IF v_bytes NOT BETWEEN 1 AND 5242880 THEN RAISE EXCEPTION 'REFERENCE_TOO_LARGE' USING errcode = '22023'; END IF;
  IF v_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  v_ext := lower(split_part(v_path, '.', -1));
  IF p_kind = 'wireframe' THEN
    IF v_mime NOT IN ('image/png','image/jpeg','image/webp') THEN RAISE EXCEPTION 'UNSUPPORTED_IMAGE_TYPE' USING errcode = '22023'; END IF;
    IF (v_mime = 'image/png') <> (v_ext = 'png') OR (v_mime = 'image/webp') <> (v_ext = 'webp') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    IF v_mime = 'image/jpeg' AND v_ext NOT IN ('jpg','jpeg') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  ELSE
    -- A matte is a canvas of alpha values; anything else cannot mask a crop.
    IF v_mime <> 'image/png' OR v_ext <> 'png' THEN RAISE EXCEPTION 'UNSUPPORTED_IMAGE_TYPE' USING errcode = '22023'; END IF;
  END IF;
  -- The object name is derived from the ids, exactly like an asset version path.
  IF v_path NOT IN (
      p_workspace_id::text || '/styles/' || p_style_id::text || '/sources/' || p_asset_id::text || '/' || p_version_id::text || '/source.' || v_ext
  ) OR v_ext NOT IN ('png','jpg','jpeg','webp') THEN
    RAISE EXCEPTION 'INVALID_STORAGE_PATH' USING errcode = '22023'; END IF;

  IF p_kind = 'element_matte' THEN
    IF p_context IS NULL OR jsonb_typeof(p_context) <> 'object' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    IF NOT public.is_game_ui_uuid(p_context->>'render_id') OR NOT public.is_game_ui_uuid(p_context->>'element_set_id')
       OR NOT public.is_game_ui_uuid(p_context->>'element_id') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    v_render_id := (p_context->>'render_id')::uuid; v_set_id := (p_context->>'element_set_id')::uuid;
    v_element_id := (p_context->>'element_id')::uuid;
    SELECT * INTO v_render FROM public.game_ui_renders WHERE id = v_render_id AND style_id = p_style_id AND workspace_id = p_workspace_id;
    IF v_render.id IS NULL THEN RAISE EXCEPTION 'RENDER_NOT_FOUND' USING errcode = 'P0002'; END IF;
    SELECT * INTO v_set FROM public.game_ui_element_sets WHERE id = v_set_id AND render_id = v_render_id;
    IF v_set.id IS NULL THEN RAISE EXCEPTION 'RENDER_NOT_FOUND' USING errcode = 'P0002'; END IF;
    SELECT value INTO v_element FROM jsonb_array_elements(v_set.document->'elements') WHERE value->>'id' = v_element_id::text;
    IF v_element IS NULL OR v_element->>'kind' = 'group' THEN RAISE EXCEPTION 'ELEMENT_NOT_FOUND' USING errcode = 'P0002'; END IF;
    v_bounds := v_element->'bounds';
    -- A matte covers exactly the element's crop; anything else would shift alpha.
    IF v_width <> (v_bounds->>'width')::int OR v_height <> (v_bounds->>'height')::int THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
    IF v_render.asset_id IS NULL THEN RAISE EXCEPTION 'RENDER_NOT_FOUND' USING errcode = 'P0002'; END IF;
  END IF;

  SELECT * INTO v_input FROM public.game_ui_inputs WHERE id = p_input_id;
  IF v_input.id IS NOT NULL THEN
    IF v_input.version_id <> p_version_id OR v_input.kind <> p_kind OR v_input.style_id <> p_style_id THEN
      RAISE EXCEPTION 'CONFLICT' USING errcode = '23000'; END IF;
    DELETE FROM public.game_ui_uploads WHERE version_id = p_version_id;
    RETURN v_input;
  END IF;

  INSERT INTO public.assets(id, project_id, style_id, name, kind)
    VALUES (p_asset_id, NULL, p_style_id, coalesce(nullif(btrim(v_name), ''), 'Game UI input'), 'uploaded')
    ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.assets WHERE id = p_asset_id AND style_id = p_style_id AND project_id IS NULL) THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
  INSERT INTO public.asset_versions(id, asset_id, source, storage_path, mime_type, width, height, byte_size, prompt, metadata)
    VALUES (p_version_id, p_asset_id, 'upload', v_path, v_mime, v_width, v_height, v_bytes, NULL,
            jsonb_build_object('role','game_ui_input','input_kind',p_kind,'content_hash',v_hash))
    ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.asset_versions WHERE id = p_version_id AND asset_id = p_asset_id) THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
  UPDATE public.assets SET current_version_id = p_version_id, updated_at = now() WHERE id = p_asset_id;

  INSERT INTO public.game_ui_inputs(id, workspace_id, style_id, version_id, kind, content_hash, render_id, element_set_id, element_id, width, height)
    VALUES (p_input_id, p_workspace_id, p_style_id, p_version_id, p_kind, v_hash, v_render_id, v_set_id, v_element_id, v_width, v_height)
    RETURNING * INTO v_input;
  -- Bookkeeping row and committed rows now agree; the ambiguity is over.
  DELETE FROM public.game_ui_uploads WHERE version_id = p_version_id;
  RETURN v_input;
END; $$;
REVOKE ALL ON FUNCTION public.register_game_ui_input(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_game_ui_input(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb) TO service_role;

-- Deterministic extraction commit: separate style-owned asset for the element,
-- with the exact provenance the manifest needs.
CREATE OR REPLACE FUNCTION public.commit_game_ui_extraction(
  p_output_id uuid, p_render_id uuid, p_element_set_id uuid, p_element_id uuid, p_matte_input_id uuid,
  p_asset_id uuid, p_version_id uuid, p_file jsonb
) RETURNS public.game_ui_element_outputs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_render public.game_ui_renders; v_set public.game_ui_element_sets; v_matte public.game_ui_inputs;
  v_element jsonb; v_output public.game_ui_element_outputs; v_existing public.game_ui_element_outputs;
  v_path text; v_mime text; v_ext text; v_width integer; v_height integer; v_bytes bigint; v_hash text;
  v_alpha text; v_name text; v_bounds jsonb;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_REQUIRED' USING errcode = '42501'; END IF;
  SELECT * INTO v_render FROM public.game_ui_renders WHERE id = p_render_id;
  IF v_render.id IS NULL THEN RAISE EXCEPTION 'RENDER_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.styles WHERE id = v_render.style_id AND workspace_id = v_render.workspace_id AND domain = 'game_ui') THEN
    RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT * INTO v_set FROM public.game_ui_element_sets WHERE id = p_element_set_id AND render_id = p_render_id;
  IF v_set.id IS NULL THEN RAISE EXCEPTION 'RENDER_NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT value INTO v_element FROM jsonb_array_elements(v_set.document->'elements') WHERE value->>'id' = p_element_id::text;
  IF v_element IS NULL OR v_element->>'kind' = 'group' THEN RAISE EXCEPTION 'ELEMENT_NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT * INTO v_matte FROM public.game_ui_inputs
    WHERE id = p_matte_input_id AND kind = 'element_matte' AND render_id = p_render_id
      AND element_set_id = p_element_set_id AND element_id = p_element_id AND style_id = v_render.style_id;
  IF v_matte.id IS NULL THEN RAISE EXCEPTION 'INPUT_NOT_FOUND' USING errcode = 'P0002'; END IF;

  IF p_file IS NULL OR jsonb_typeof(p_file) <> 'object' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  v_path := coalesce(p_file->>'storage_path',''); v_mime := coalesce(p_file->>'mime_type','');
  v_hash := coalesce(p_file->>'content_hash',''); v_name := coalesce(p_file->>'name','');
  v_alpha := coalesce(p_file->>'alpha_status','');
  v_bytes := coalesce((p_file->>'byte_size')::bigint, 0);
  v_width := coalesce((p_file->>'width')::integer, 0); v_height := coalesce((p_file->>'height')::integer, 0);
  IF (p_file->>'width') !~ '^[0-9]+$' OR (p_file->>'height') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  v_ext := lower(split_part(v_path, '.', -1));
  IF v_mime <> 'image/png' OR v_ext <> 'png' THEN RAISE EXCEPTION 'UNSUPPORTED_IMAGE_TYPE' USING errcode = '22023'; END IF;
  IF v_bytes NOT BETWEEN 1 AND 5242880 THEN RAISE EXCEPTION 'REFERENCE_TOO_LARGE' USING errcode = '22023'; END IF;
  IF v_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  IF v_alpha NOT IN ('transparent','opaque') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  v_bounds := v_element->'bounds';
  -- No trim, no resize: an extracted element is exactly its box.
  IF v_width <> (v_bounds->>'width')::int OR v_height <> (v_bounds->>'height')::int THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  IF v_matte.width <> v_width OR v_matte.height <> v_height THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  IF v_path NOT IN (
      v_render.workspace_id::text || '/styles/' || v_render.style_id::text || '/outputs/' || p_asset_id::text || '/' || p_version_id::text || '/source.' || v_ext
  ) THEN RAISE EXCEPTION 'INVALID_STORAGE_PATH' USING errcode = '22023'; END IF;

  SELECT * INTO v_existing FROM public.game_ui_element_outputs WHERE id = p_output_id;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.version_id <> p_version_id OR v_existing.render_id <> p_render_id
       OR v_existing.element_set_id <> p_element_set_id OR v_existing.element_id <> p_element_id THEN
      RAISE EXCEPTION 'CONFLICT' USING errcode = '23000'; END IF;
    DELETE FROM public.game_ui_uploads WHERE version_id = p_version_id;
    RETURN v_existing;
  END IF;

  INSERT INTO public.assets(id, project_id, style_id, name, kind)
    VALUES (p_asset_id, NULL, v_render.style_id, coalesce(nullif(btrim(v_name), ''), 'Game UI element'), 'generated')
    ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.assets WHERE id = p_asset_id AND style_id = v_render.style_id AND project_id IS NULL) THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
  INSERT INTO public.asset_versions(id, asset_id, source, storage_path, mime_type, width, height, byte_size, prompt, metadata)
    VALUES (p_version_id, p_asset_id, 'extraction', v_path, v_mime, v_width, v_height, v_bytes, NULL,
            jsonb_build_object('role','game_ui_element_output','mode','exact','content_hash',v_hash,
                               'source_version_id',v_render.version_id::text,'element_id',p_element_id::text,
                               'element_set_id',p_element_set_id::text,'source_bounds',v_bounds,'matte_hash',v_matte.content_hash))
    ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.asset_versions WHERE id = p_version_id AND asset_id = p_asset_id) THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING errcode = '23000'; END IF;
  UPDATE public.assets SET current_version_id = p_version_id, updated_at = now() WHERE id = p_asset_id;

  INSERT INTO public.game_ui_element_outputs(
      id, workspace_id, render_id, element_set_id, element_id, mode, matte_input_id, job_id,
      asset_id, version_id, alpha_status, source_bounds)
    VALUES (p_output_id, v_render.workspace_id, p_render_id, p_element_set_id, p_element_id, 'exact', p_matte_input_id, NULL,
            p_asset_id, p_version_id, v_alpha, v_bounds)
    RETURNING * INTO v_output;
  DELETE FROM public.game_ui_uploads WHERE version_id = p_version_id;
  RETURN v_output;
END; $$;
REVOKE ALL ON FUNCTION public.commit_game_ui_extraction(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_game_ui_extraction(uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.review_game_ui_output(
  p_output_id uuid, p_expected_status text, p_status text
) RETURNS public.game_ui_element_outputs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_output public.game_ui_element_outputs;
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_status NOT IN ('accepted','discarded') OR p_expected_status NOT IN ('pending','accepted','discarded') THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  SELECT * INTO v_output FROM public.game_ui_element_outputs
    WHERE id = p_output_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF v_output.id IS NULL THEN RAISE EXCEPTION 'OUTPUT_NOT_FOUND' USING errcode = 'P0002'; END IF;
  -- A review is a decision about one known output; two tabs must not silently
  -- overwrite each other's judgement.
  IF v_output.review_status <> p_expected_status THEN RAISE EXCEPTION 'SCREEN_VERSION_CONFLICT' USING errcode = '23000'; END IF;
  IF p_status = 'accepted' AND v_output.alpha_status <> 'transparent' THEN
    RAISE EXCEPTION 'TRANSPARENCY_REQUIRED' USING errcode = '22023'; END IF;
  UPDATE public.game_ui_element_outputs SET review_status = p_status WHERE id = p_output_id RETURNING * INTO v_output;
  RETURN v_output;
END; $$;
REVOKE ALL ON FUNCTION public.review_game_ui_output(uuid,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.review_game_ui_output(uuid,text,text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Domain-aware confirmation and schema writes
-- ---------------------------------------------------------------------------

-- A Game UI definition is version 2 and carries its domain, so a version 1
-- definition can never be read as a Game UI style and vice versa.
CREATE OR REPLACE FUNCTION public.guard_style_definition_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_version integer;
BEGIN
  IF NEW.confirmed_definition IS DISTINCT FROM OLD.confirmed_definition
     AND coalesce(current_setting('app.style_definition_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'CONFIRMED_DEFINITION_PROTECTED' USING errcode = '42501';
  END IF;
  IF NEW.confirmed_definition IS NOT NULL THEN
    IF jsonb_typeof(NEW.confirmed_definition) <> 'object' THEN
      RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
    v_version := coalesce((NEW.confirmed_definition->>'definition_version')::int, 0);
    IF jsonb_typeof(NEW.confirmed_definition->'reference_snapshot') <> 'array'
       OR jsonb_array_length(NEW.confirmed_definition->'reference_snapshot') NOT BETWEEN 1 AND 20 THEN
      RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
    IF v_version = 1 THEN
      IF coalesce(NEW.domain, 'visual') <> 'visual' OR jsonb_typeof(NEW.confirmed_definition->'schema_snapshot') <> 'object' THEN
        RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
    ELSIF v_version = 2 THEN
      IF coalesce(NEW.domain, '') <> 'game_ui' THEN
        RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
      PERFORM public.assert_game_ui_style_schema(NEW.confirmed_definition->'schema_snapshot');
      IF coalesce(NEW.confirmed_definition->>'domain','') <> 'game_ui' THEN
        RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023'; END IF;
    ELSE
      RAISE EXCEPTION 'INVALID_CONFIRMED_DEFINITION' USING errcode = '22023';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.confirm_style_definition(p_style_id uuid, p_expected_updated_at timestamptz)
RETURNS public.styles LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_style public.styles; v_live jsonb; v_snapshot jsonb; v_meta jsonb; v_grade text;
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT * INTO v_style FROM public.styles
    WHERE id = p_style_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF v_style.id IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_expected_updated_at IS NULL OR v_style.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'STYLE_VERSION_CONFLICT' USING errcode = '23000'; END IF;

  -- Candidate must be a complete, analysed schema.  The two domains store
  -- different schemas, so the completeness check is the domain's own.
  IF v_style.domain = 'game_ui' THEN
    PERFORM public.assert_game_ui_style_schema(v_style.schema);
    IF coalesce(v_style.fingerprint->>'domain','') <> 'game_ui' OR coalesce(v_style.invariant_contract->>'domain','') <> 'game_ui' THEN
      RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;
  ELSE
    IF jsonb_typeof(v_style.schema) <> 'object'
       OR NOT (v_style.schema ?& array['style_name','version','subject_type','subject','environment','composition','lighting','color_palette','artistic_style','mood_atmosphere','material_texture','technical_quality','camera_lens','post_processing','negative_prompt','generation_params'])
       OR jsonb_typeof(v_style.fingerprint) <> 'object'
       OR jsonb_typeof(v_style.invariant_contract) <> 'object' THEN
      RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;
  END IF;
  v_meta := coalesce(v_style.analysis_meta, '{}'::jsonb);
  IF v_meta->>'analyzedAt' IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;
  v_grade := v_style.operability->>'grade';
  IF v_grade NOT IN ('production_ready','usable_with_warnings') THEN
    RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'content_hash', r.content_hash) ORDER BY r.created_at, r.id), '[]'::jsonb)
    INTO v_live FROM public.style_references r WHERE r.style_id = p_style_id AND r.retired_at IS NULL;
  IF jsonb_array_length(v_live) < 1 THEN RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_live) e WHERE coalesce(e->>'content_hash','') !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'STYLE_NOT_READY' USING errcode = 'P0002'; END IF;

  -- The analysed reference set must still be the live one; anything else is stale.
  v_snapshot := v_meta->'reference_snapshot';
  IF jsonb_typeof(v_snapshot) <> 'array'
     OR jsonb_array_length(v_snapshot) <> jsonb_array_length(v_live)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_snapshot) s
       WHERE NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_live) l
         WHERE l->>'id' = s->>'id' AND coalesce(l->>'content_hash','') = coalesce(s->>'content_hash','')
       )
     ) THEN
    RAISE EXCEPTION 'STYLE_ANALYSIS_STALE' USING errcode = '23000'; END IF;

  PERFORM set_config('app.style_definition_write', 'on', true);
  IF v_style.domain = 'game_ui' THEN
    UPDATE public.styles
      SET confirmed_definition = jsonb_build_object(
            'definition_version', 2,
            'domain', 'game_ui',
            'style_revision', gen_random_uuid(),
            'schema_snapshot', v_style.schema,
            'reference_snapshot', v_live,
            'confirmed_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
          status = 'active',
          updated_at = now()
      WHERE id = p_style_id
      RETURNING * INTO v_style;
  ELSE
    UPDATE public.styles
      SET confirmed_definition = jsonb_build_object(
            'definition_version', 1,
            'style_revision', gen_random_uuid(),
            'schema_snapshot', v_style.schema,
            'reference_snapshot', v_live,
            'confirmed_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
          status = 'active',
          updated_at = now()
      WHERE id = p_style_id
      RETURNING * INTO v_style;
  END IF;
  RETURN v_style;
END; $$;
REVOKE ALL ON FUNCTION public.confirm_style_definition(uuid, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.confirm_style_definition(uuid, timestamptz) TO authenticated;

-- Analysis and manual schema writes must land a schema the domain can use; the
-- durable gate is here, not only in the route that produced the JSON.
CREATE OR REPLACE FUNCTION public.commit_style_analysis(
  p_style_id uuid,
  p_expected_updated_at timestamptz,
  p_reference_snapshot jsonb,
  p_schema jsonb,
  p_fingerprint jsonb,
  p_invariant_contract jsonb,
  p_style_fields jsonb,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS public.styles LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_style public.styles; v_live jsonb;
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT * INTO v_style FROM public.styles
    WHERE id = p_style_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF v_style.id IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_expected_updated_at IS NULL OR v_style.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'STYLE_ANALYSIS_STALE' USING errcode = '23000'; END IF;
  IF v_style.domain = 'game_ui' THEN PERFORM public.assert_game_ui_style_schema(p_schema); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'content_hash', r.content_hash) ORDER BY r.created_at, r.id), '[]'::jsonb)
    INTO v_live FROM public.style_references r WHERE r.style_id = p_style_id AND r.retired_at IS NULL;
  IF jsonb_typeof(p_reference_snapshot) <> 'array'
     OR jsonb_array_length(p_reference_snapshot) <> jsonb_array_length(v_live)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_reference_snapshot) s
       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_live) l
         WHERE l->>'id' = s->>'id' AND coalesce(l->>'content_hash','') = coalesce(s->>'content_hash',''))
     ) THEN
    RAISE EXCEPTION 'STYLE_ANALYSIS_STALE' USING errcode = '23000'; END IF;

  UPDATE public.styles SET
      schema = p_schema,
      fingerprint = p_fingerprint,
      invariant_contract = p_invariant_contract,
      name = CASE WHEN p_style_fields ? 'name' THEN coalesce(p_style_fields->>'name', name) ELSE name END,
      status = CASE WHEN p_style_fields ? 'status' THEN coalesce(p_style_fields->>'status', status) ELSE status END,
      library_id = CASE WHEN p_style_fields ? 'library_id' THEN (p_style_fields->>'library_id')::uuid ELSE library_id END,
      analysis_meta = CASE WHEN p_style_fields ? 'analysis_meta' THEN p_style_fields->'analysis_meta' ELSE analysis_meta END,
      clarification_questions = CASE WHEN p_style_fields ? 'clarification_questions' THEN p_style_fields->'clarification_questions' ELSE clarification_questions END,
      clarification_answers = CASE WHEN p_style_fields ? 'clarification_answers' THEN p_style_fields->'clarification_answers' ELSE clarification_answers END,
      operability = CASE WHEN p_style_fields ? 'operability' THEN p_style_fields->'operability' ELSE operability END,
      last_fidelity = CASE WHEN p_style_fields ? 'last_fidelity' THEN p_style_fields->'last_fidelity' ELSE last_fidelity END,
      updated_at = now()
    WHERE id = p_style_id RETURNING * INTO v_style;

  INSERT INTO public.style_schema_versions(style_id, source, schema, fingerprint, invariant_contract, metadata)
    VALUES (p_style_id, 'analysis', p_schema, p_fingerprint, p_invariant_contract, p_metadata);
  RETURN v_style;
END; $$;
REVOKE ALL ON FUNCTION public.commit_style_analysis(uuid,timestamptz,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.commit_style_analysis(uuid,timestamptz,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.commit_style_schema_mutation(
  p_style_id uuid,
  p_expected_updated_at timestamptz,
  p_source text,
  p_schema jsonb,
  p_fingerprint jsonb,
  p_invariant_contract jsonb,
  p_style_fields jsonb,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS public.styles LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_style public.styles;
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_source NOT IN ('analysis','user_validation','tuning','manual') THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  SELECT * INTO v_style FROM public.styles
    WHERE id = p_style_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF v_style.id IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_expected_updated_at IS NOT NULL AND v_style.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'STYLE_VERSION_CONFLICT' USING errcode = '23000'; END IF;
  IF v_style.domain = 'game_ui' THEN PERFORM public.assert_game_ui_style_schema(p_schema); END IF;
  IF p_style_fields ? 'library_id' THEN
    IF NOT EXISTS (SELECT 1 FROM public.style_libraries
        WHERE id = (p_style_fields->>'library_id')::uuid AND workspace_id = v_style.workspace_id) THEN
      RAISE EXCEPTION 'INVALID_LIBRARY' USING errcode = '23503'; END IF;
  END IF;

  UPDATE public.styles SET
      schema = p_schema,
      fingerprint = p_fingerprint,
      invariant_contract = p_invariant_contract,
      name = CASE WHEN p_style_fields ? 'name' THEN coalesce(p_style_fields->>'name', name) ELSE name END,
      status = CASE WHEN p_style_fields ? 'status' THEN coalesce(p_style_fields->>'status', status) ELSE status END,
      library_id = CASE WHEN p_style_fields ? 'library_id' THEN (p_style_fields->>'library_id')::uuid ELSE library_id END,
      analysis_meta = CASE WHEN p_style_fields ? 'analysis_meta' THEN p_style_fields->'analysis_meta' ELSE analysis_meta END,
      clarification_questions = CASE WHEN p_style_fields ? 'clarification_questions' THEN p_style_fields->'clarification_questions' ELSE clarification_questions END,
      clarification_answers = CASE WHEN p_style_fields ? 'clarification_answers' THEN p_style_fields->'clarification_answers' ELSE clarification_answers END,
      operability = CASE WHEN p_style_fields ? 'operability' THEN p_style_fields->'operability' ELSE operability END,
      last_fidelity = CASE WHEN p_style_fields ? 'last_fidelity' THEN p_style_fields->'last_fidelity' ELSE last_fidelity END,
      updated_at = now()
    WHERE id = p_style_id RETURNING * INTO v_style;

  INSERT INTO public.style_schema_versions(style_id, source, schema, fingerprint, invariant_contract, metadata)
    VALUES (p_style_id, p_source, p_schema, p_fingerprint, p_invariant_contract, p_metadata);
  RETURN v_style;
END; $$;
REVOKE ALL ON FUNCTION public.commit_style_schema_mutation(uuid,timestamptz,text,jsonb,jsonb,jsonb,jsonb,jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.commit_style_schema_mutation(uuid,timestamptz,text,jsonb,jsonb,jsonb,jsonb,jsonb) TO authenticated;

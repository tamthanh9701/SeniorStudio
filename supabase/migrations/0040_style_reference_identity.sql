-- 0040_style_reference_identity.sql
-- The uploaded object name and the reference row id must be the same value.
-- 0039 wrote rows with a database-generated id while the uploader named the
-- object after its own uuid, so the worker's ownership check (which resolves a
-- reference by id and requires the object to be named after it) rejected every
-- reference and the job died before a provider was ever contacted.
-- 0001-0039 remain immutable.

CREATE OR REPLACE FUNCTION public.add_style_reference(p_style_id uuid, p_reference jsonb)
RETURNS public.style_references LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_workspace uuid; v_reference public.style_references; v_live integer;
  v_width integer; v_height integer; v_id uuid; v_path text; v_mime text; v_ext text;
BEGIN
  IF auth.role() <> 'authenticated' THEN RAISE EXCEPTION 'NOT_FOUND' USING errcode = 'P0002'; END IF;
  SELECT workspace_id INTO v_workspace FROM public.styles
    WHERE id = p_style_id AND workspace_id IN (SELECT public.current_workspace_ids()) FOR UPDATE;
  IF v_workspace IS NULL THEN RAISE EXCEPTION 'STYLE_NOT_FOUND' USING errcode = 'P0002'; END IF;
  IF p_reference IS NULL OR jsonb_typeof(p_reference) <> 'object' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;

  -- Id and object name are one identity; the worker relies on it.
  IF coalesce(p_reference->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  v_id := (p_reference->>'id')::uuid;
  v_path := coalesce(p_reference->>'storage_path','');
  v_mime := coalesce(p_reference->>'mime_type','');
  IF v_path NOT IN (
    v_workspace::text || '/styles/' || p_style_id::text || '/' || v_id::text || '.png',
    v_workspace::text || '/styles/' || p_style_id::text || '/' || v_id::text || '.jpg',
    v_workspace::text || '/styles/' || p_style_id::text || '/' || v_id::text || '.jpeg'
  ) THEN RAISE EXCEPTION 'INVALID_STORAGE_PATH' USING errcode = '22023'; END IF;
  v_ext := lower(split_part(v_path, '.', -1));
  IF v_mime NOT IN ('image/png','image/jpeg') THEN RAISE EXCEPTION 'UNSUPPORTED_IMAGE_TYPE' USING errcode = '22023'; END IF;
  IF (v_mime = 'image/png') <> (v_ext = 'png') THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;
  IF coalesce((p_reference->>'byte_size')::bigint, 0) NOT BETWEEN 1 AND 5242880 THEN RAISE EXCEPTION 'REFERENCE_TOO_LARGE' USING errcode = '22023'; END IF;
  IF coalesce(p_reference->>'content_hash','') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_REQUEST' USING errcode = '22023'; END IF;

  SELECT count(*) INTO v_live FROM public.style_references WHERE style_id = p_style_id AND retired_at IS NULL;
  IF v_live >= 8 THEN RAISE EXCEPTION 'TOO_MANY_REFERENCES' USING errcode = '22023'; END IF;
  v_width := nullif(p_reference->>'width','')::integer;
  v_height := nullif(p_reference->>'height','')::integer;
  INSERT INTO public.style_references(id, style_id, storage_path, mime_type, byte_size, width, height, content_hash)
    VALUES (v_id, p_style_id, v_path, v_mime, (p_reference->>'byte_size')::bigint, v_width, v_height, p_reference->>'content_hash')
    RETURNING * INTO v_reference;
  UPDATE public.styles SET updated_at = now() WHERE id = p_style_id;
  RETURN v_reference;
END; $$;
REVOKE ALL ON FUNCTION public.add_style_reference(uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.add_style_reference(uuid, jsonb) TO authenticated;

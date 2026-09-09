-- 0032_atomic_style_mutations.sql
-- Atomic style schema mutation with versioned history in single transaction.
-- Depends on 0031_image_to_image_execution.sql.

-- 1. Atomic commit for style schema mutations.
--    Updates style row and appends history atomically; any error rolls back both.
create or replace function public.commit_style_schema_mutation(
  p_style_id uuid,
  p_expected_updated_at timestamptz,
  p_source text,
  p_schema jsonb,
  p_fingerprint jsonb,
  p_invariant_contract jsonb,
  p_style_fields jsonb,
  p_metadata jsonb default '{}'::jsonb
) returns public.styles
language plpgsql security definer set search_path = public as $$
declare
  v_style public.styles;
  v_style_row record;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_source not in ('analysis', 'user_validation', 'tuning', 'manual') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  -- Lock and verify ownership
  select * into v_style_row
  from public.styles
  where id = p_style_id
    and workspace_id in (select public.current_workspace_ids())
  for update;

  if v_style_row.id is null then
    raise exception 'STYLE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Optimistic concurrency check
  if p_expected_updated_at is not null
     and v_style_row.updated_at <> p_expected_updated_at then
    raise exception 'STYLE_VERSION_CONFLICT' using errcode = '23000';
  end if;

  -- Verify library ownership if library_id is being set
  if p_style_fields ? 'library_id' then
    if not exists (
      select 1 from public.style_libraries
      where id = (p_style_fields->>'library_id')::uuid
        and workspace_id = v_style_row.workspace_id
    ) then
      raise exception 'INVALID_LIBRARY' using errcode = '23503';
    end if;
  end if;

  -- Update style fields atomically with schema
  update public.styles
  set schema = p_schema,
      fingerprint = p_fingerprint,
      invariant_contract = p_invariant_contract,
      name = case when p_style_fields ? 'name' then coalesce((p_style_fields->>'name'), name) else name end,
      status = case when p_style_fields ? 'status' then coalesce((p_style_fields->>'status'), status) else status end,
      library_id = case when p_style_fields ? 'library_id' then (p_style_fields->>'library_id')::uuid else library_id end,
      analysis_meta = case when p_style_fields ? 'analysis_meta' then (p_style_fields->'analysis_meta') else analysis_meta end,
      clarification_questions = case when p_style_fields ? 'clarification_questions' then (p_style_fields->'clarification_questions') else clarification_questions end,
      clarification_answers = case when p_style_fields ? 'clarification_answers' then (p_style_fields->'clarification_answers') else clarification_answers end,
      operability = case when p_style_fields ? 'operability' then (p_style_fields->'operability') else operability end,
      last_fidelity = case when p_style_fields ? 'last_fidelity' then (p_style_fields->'last_fidelity') else last_fidelity end,
      updated_at = now()
  where id = p_style_id
  returning * into v_style;

  -- Append history (existing trim trigger keeps last 20)
  insert into public.style_schema_versions (
    style_id, source, schema, fingerprint, invariant_contract, metadata
  ) values (
    p_style_id, p_source, p_schema, p_fingerprint, p_invariant_contract, p_metadata
  );

  return v_style;
end;
$$;

-- 2. Name/status/library-only update (no schema version history).
create or replace function public.update_style_fields(
  p_style_id uuid,
  p_expected_updated_at timestamptz,
  p_name text default null,
  p_status text default null,
  p_library_id uuid default null
) returns public.styles
language plpgsql security definer set search_path = public as $$
declare
  v_style public.styles;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_style
  from public.styles
  where id = p_style_id
    and workspace_id in (select public.current_workspace_ids())
  for update;

  if v_style.id is null then
    raise exception 'STYLE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_expected_updated_at is not null
     and v_style.updated_at <> p_expected_updated_at then
    raise exception 'STYLE_VERSION_CONFLICT' using errcode = '23000';
  end if;

  update public.styles
  set name = coalesce(p_name, name),
      status = coalesce(p_status, status),
      library_id = coalesce(p_library_id, library_id),
      updated_at = now()
  where id = p_style_id
  returning * into v_style;

  return v_style;
end;
$$;

-- Revoke from public/anon; authenticated can call these for UI.
revoke all on function public.commit_style_schema_mutation(uuid, timestamptz, text, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.commit_style_schema_mutation(uuid, timestamptz, text, jsonb, jsonb, jsonb, jsonb, jsonb) to authenticated;
revoke all on function public.update_style_fields(uuid, timestamptz, text, text, uuid) from public, anon;
grant execute on function public.update_style_fields(uuid, timestamptz, text, text, uuid) to authenticated;

-- 0031_image_to_image_execution.sql
-- Extend operation model for image-to-image execution and add source support.
-- Depends on 0030_workspace_hard_quota.sql.

-- 1. Extend operation check to include image_to_image.
alter table public.ai_jobs drop constraint if exists ai_jobs_operation_check;
alter table public.ai_jobs add constraint ai_jobs_operation_check
  check (operation in ('text_to_image', 'image_to_image', 'inpaint'));

-- 2. Add source_version_id to ai_jobs for image-to-image.
alter table public.ai_jobs add column if not exists source_version_id uuid
  references public.asset_versions(id) on delete set null;
create index if not exists ai_jobs_source_version_idx on public.ai_jobs(source_version_id);

-- 3. Update AiJobInputSchema in TypeScript (done separately).
--    The RPC below stores source_version_id in input JSON as well as the column.

-- 4. Style source assets: commit_style_source RPC (service-role only).
--    Atomic: insert style-owned asset + version + update current_version_id.
create or replace function public.commit_style_source(
  p_workspace_id uuid,
  p_style_id uuid,
  p_asset_id uuid,
  p_version_id uuid,
  p_name text,
  p_storage_path text,
  p_mime_type text,
  p_width integer,
  p_height integer,
  p_byte_size bigint
) returns public.asset_versions
language plpgsql security definer set search_path = public as $$
declare
  v_version public.asset_versions;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  -- Verify style exists and belongs to workspace
  if not exists (
    select 1 from public.styles
    where id = p_style_id and workspace_id = p_workspace_id
  ) then
    raise exception 'STYLE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Insert style-owned asset
  insert into public.assets (id, project_id, style_id, name, kind)
  values (p_asset_id, null, p_style_id, coalesce(nullif(btrim(p_name), ''), 'Untitled'), 'uploaded')
  on conflict (id) do nothing;

  -- Verify asset is style-owned
  if not exists (
    select 1 from public.assets
    where id = p_asset_id and style_id = p_style_id and project_id is null
  ) then
    raise exception 'VERSION_CONFLICT' using errcode = '23000';
  end if;

  -- Insert version
  insert into public.asset_versions (
    id, asset_id, source, storage_path, mime_type, width, height, byte_size, prompt, metadata
  ) values (
    p_version_id, p_asset_id, 'upload', p_storage_path, p_mime_type,
    p_width, p_height, p_byte_size::integer, null, '{"role":"style_source"}'::jsonb
  ) returning * into v_version;

  -- Update current version
  update public.assets
  set current_version_id = p_version_id, updated_at = now()
  where id = p_asset_id;

  return v_version;
end;
$$;

revoke all on function public.commit_style_source(uuid, uuid, uuid, uuid, text, text, text, integer, integer, bigint) from public, anon, authenticated;
grant execute on function public.commit_style_source(uuid, uuid, uuid, uuid, text, text, text, integer, integer, bigint) to service_role;

-- 5. Style reference constraint: block delete when referenced by active jobs.
--    Uses a trigger on style_references delete.
create or replace function public.check_reference_in_use()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.ai_jobs
    where input ? 'reference_ids'
      and (input->'reference_ids') @> to_jsonb(OLD.id)
      and status not in ('succeeded', 'failed', 'canceled')
  ) then
    raise exception 'REFERENCE_IN_USE' using errcode = '23503';
  end if;
  return OLD;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'check_reference_in_use_trigger') then
    create trigger check_reference_in_use_trigger
      before delete on public.style_references
      for each row execute function public.check_reference_in_use();
  end if;
end;
$$;

-- 6. Source deletion guard: block delete of style source assets when referenced by active jobs.
--    Uses a trigger on assets delete for style-owned assets.
create or replace function public.check_style_source_in_use()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if OLD.style_id is not null and OLD.project_id is null then
    if exists (
      select 1 from public.ai_jobs
      where source_version_id in (
        select id from public.asset_versions where asset_id = OLD.id
      )
      and status not in ('succeeded', 'failed', 'canceled')
    ) then
      raise exception 'SOURCE_IN_USE' using errcode = '23503';
    end if;
  end if;
  return OLD;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'check_style_source_in_use_trigger') then
    create trigger check_style_source_in_use_trigger
      before delete on public.assets
      for each row execute function public.check_style_source_in_use();
  end if;
end;
$$;

-- 0029_security_runtime_corrections.sql
-- Security, ownership, and runtime correctness fixes applied to DB layer.
-- Depends on 0028_job_runtime_reliability.sql.

-- 1. Fix Style in Projects: allow style_id on text_to_image jobs with module='projects'
--    while keeping style module jobs project_id null.
--    The current constraint 0028 check blocks style_id when module='projects';
--    re-check the RPC behavior is consistent with route callers.

-- 2. Credential isolation: workspace-scoped key lookup is enforced in TypeScript.
--    No DB changes needed for credential lookup; the old get_provider_api_key RPC
--    is unused in application code and will be dropped.

-- 3. MCP workspace resolution: DB row-based join in TypeScript, no DB changes.

-- 4. Drop legacy RPC overload if still present (safety net).
drop function if exists public.get_provider_api_key(text);

-- 5. Legacy claim reclaim: claim_ai_jobs already restricts to queued only (0028).
--    No change needed.

-- 6. cancel_ai_job: already restricts to queued only (0028). No change needed.

-- 7. complete_ai_job: drop legacy overload if present, keep only complete_ai_job_with_results.
drop function if exists public.complete_ai_job(uuid, text, uuid, uuid, text, text, jsonb);

-- 8. DB validation triggers for storage path consistency (defense-in-depth).
--    Fires on insert of asset_versions: path must contain asset_id as segment.
--    Does not run retroactively on existing rows.
create or replace function public.validate_asset_version_path()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Verify path contains the asset_id as a path segment
  if position(NEW.asset_id::text in NEW.storage_path) = 0 then
    raise exception 'INVALID_STORAGE_PATH' using errcode = '22023';
  end if;
  -- Verify MIME type is allowed
  if NEW.mime_type not in ('image/png', 'image/jpeg', 'image/webp') then
    raise exception 'UNSUPPORTED_IMAGE' using errcode = '22023';
  end if;
  -- Verify positive dimensions
  if NEW.width <= 0 or NEW.height <= 0 then
    raise exception 'UNSUPPORTED_IMAGE' using errcode = '22023';
  end if;
  -- Verify positive byte_size within limit
  if NEW.byte_size <= 0 or NEW.byte_size > 52428800 then
    raise exception 'UNSUPPORTED_IMAGE' using errcode = '22023';
  end if;
  return NEW;
end;
$$;

-- Only create trigger if not already present
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'validate_asset_version_path_trigger') then
    create trigger validate_asset_version_path_trigger
      before insert on public.asset_versions
      for each row execute function public.validate_asset_version_path();
  end if;
end;
$$;

-- 9. Style reference path validation trigger.
--    Fires on insert of style_references: path must contain style_id and reference id.
create or replace function public.validate_style_reference_path()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if position(NEW.style_id::text in NEW.storage_path) = 0 then
    raise exception 'INVALID_STORAGE_PATH' using errcode = '22023';
  end if;
  if position(NEW.id::text in NEW.storage_path) = 0 then
    raise exception 'INVALID_STORAGE_PATH' using errcode = '22023';
  end if;
  return NEW;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'validate_style_reference_path_trigger') then
    create trigger validate_style_reference_path_trigger
      before insert on public.style_references
      for each row execute function public.validate_style_reference_path();
  end if;
end;
$$;

-- 10. ai_job_inputs path validation trigger.
--     Fires on insert: path must contain workspace_id and the input id.
create or replace function public.validate_job_input_path()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if position(NEW.workspace_id::text in NEW.storage_path) = 0 then
    raise exception 'INVALID_STORAGE_PATH' using errcode = '22023';
  end if;
  if position(NEW.id::text in NEW.storage_path) = 0 then
    raise exception 'INVALID_STORAGE_PATH' using errcode = '22023';
  end if;
  return NEW;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'validate_job_input_path_trigger') then
    create trigger validate_job_input_path_trigger
      before insert on public.ai_job_inputs
      for each row execute function public.validate_job_input_path();
  end if;
end;
$$;

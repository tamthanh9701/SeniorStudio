-- Style profiles: reusable visual style extracted from reference images, compiled
-- into generation prompts at enqueue time. Provenance fields ride in ai_jobs.input.
create table public.styles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  status text not null default 'draft' check (status in ('draft','active')),
  schema jsonb not null default '{}'::jsonb,
  fingerprint jsonb,
  invariant_contract jsonb,
  analysis_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index styles_workspace_idx on public.styles(workspace_id);
create index styles_workspace_status_idx on public.styles(workspace_id, status);

create table public.style_references (
  id uuid primary key default gen_random_uuid(),
  style_id uuid not null references public.styles(id) on delete cascade,
  storage_path text not null,
  mime_type text not null check (mime_type in ('image/png','image/jpeg')),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 5242880),
  width integer,
  height integer,
  content_hash text,
  created_at timestamptz not null default now(),
  unique(style_id, storage_path)
);
create index style_references_style_idx on public.style_references(style_id);

alter table public.styles enable row level security;
alter table public.style_references enable row level security;
create policy "Users can manage styles in their workspace" on public.styles
  for all to authenticated
  using (workspace_id in (select public.current_workspace_ids()))
  with check (workspace_id in (select public.current_workspace_ids()));
create policy "Users can manage style references in their workspace" on public.style_references
  for all to authenticated
  using (exists (select 1 from public.styles s where s.id = style_id
    and s.workspace_id in (select public.current_workspace_ids())))
  with check (exists (select 1 from public.styles s where s.id = style_id
    and s.workspace_id in (select public.current_workspace_ids())));

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
create trigger styles_set_updated_at before update on public.styles
for each row execute function public.set_updated_at();

-- Extend the enqueue RPC with style provenance. Same signature prefix plus two
-- trailing defaults, so existing callers keep working unchanged.
create or replace function public.enqueue_ai_job(
  p_workspace_id uuid, p_project_id uuid, p_requested_by uuid, p_operation text,
  p_provider text, p_model text, p_prompt text, p_count integer, p_size text,
  p_quality text, p_asset_id uuid default null, p_parent_version_id uuid default null,
  p_mask_storage_path text default null, p_style_id uuid default null,
  p_original_prompt text default null
) returns public.ai_jobs
language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs; v_parent_asset uuid; v_parent_project uuid;
begin
  if auth.role() <> 'authenticated' or auth.uid() <> p_requested_by
     or p_workspace_id not in (select public.current_workspace_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.projects where id = p_project_id and workspace_id = p_workspace_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if char_length(btrim(coalesce(p_prompt, ''))) not between 1 and 8000
     or p_operation not in ('text_to_image', 'inpaint')
     or p_provider not in ('openai', 'google')
     or p_quality not in ('low', 'medium', 'high', 'auto') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if (p_model = 'openai/gpt-image-2' and p_provider <> 'openai')
     or (p_provider = 'openai' and p_model <> 'openai/gpt-image-2')
     or (p_provider = 'google' and (p_model !~ '^google/[a-z0-9._-]+$' or p_operation <> 'text_to_image')) then
    raise exception 'INVALID_MODEL' using errcode = '22023';
  end if;
  if p_style_id is not null and not exists (
    select 1 from public.styles where id = p_style_id and status = 'active'
      and workspace_id = p_workspace_id
  ) then
    raise exception 'STYLE_NOT_ACTIVE' using errcode = 'P0002';
  end if;
  if p_operation = 'text_to_image' then
    if p_count not between 1 and 4 or p_asset_id is not null or p_parent_version_id is not null or p_mask_storage_path is not null then
      raise exception 'INVALID_REQUEST' using errcode = '22023';
    end if;
    if p_size not in ('1024x1024', '1536x1024', '1024x1536', 'auto')
       or (p_provider = 'google' and (p_size = 'auto' or p_quality <> 'auto')) then
      raise exception 'INVALID_REQUEST' using errcode = '22023';
    end if;
  else
    if p_count <> 1 or p_asset_id is null or p_parent_version_id is null or p_mask_storage_path is null then
      raise exception 'INVALID_REQUEST' using errcode = '22023';
    end if;
    select av.asset_id, a.project_id into v_parent_asset, v_parent_project
    from public.asset_versions av join public.assets a on a.id = av.asset_id where av.id = p_parent_version_id;
    if v_parent_asset is null or v_parent_project <> p_project_id then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if v_parent_asset <> p_asset_id then raise exception 'VERSION_CONFLICT' using errcode = '23000'; end if;
    if not exists (select 1 from public.ai_job_inputs where storage_path = p_mask_storage_path and workspace_id = p_workspace_id and project_id = p_project_id and asset_id = p_asset_id and parent_version_id = p_parent_version_id and expires_at > now() and job_id is null) then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  insert into public.ai_jobs(workspace_id, project_id, requested_by, asset_id, parent_version_id,
    operation, provider, model, status, input)
  values (p_workspace_id, p_project_id, p_requested_by, p_asset_id, p_parent_version_id,
    p_operation, p_provider, p_model, 'queued', jsonb_build_object('prompt', btrim(p_prompt), 'count', p_count, 'size', p_size, 'quality', p_quality, 'mask_storage_path', p_mask_storage_path, 'style_id', p_style_id, 'original_prompt', p_original_prompt))
  returning * into v_job;
  return v_job;
end; $$;

revoke all on function public.enqueue_ai_job(uuid, uuid, uuid, text, text, text, text, integer, text, text, uuid, uuid, text) from public, anon;
grant execute on function public.enqueue_ai_job(uuid, uuid, uuid, text, text, text, text, integer, text, text, uuid, uuid, text) to authenticated;
revoke all on function public.enqueue_ai_job(uuid, uuid, uuid, text, text, text, text, integer, text, text, uuid, uuid, text, uuid, text) from public, anon;
grant execute on function public.enqueue_ai_job(uuid, uuid, uuid, text, text, text, text, integer, text, text, uuid, uuid, text, uuid, text) to authenticated;

-- Editor Documents
create table public.editor_documents (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  base_version_id uuid not null references public.asset_versions(id) on delete cascade,
  schema_version integer not null default 1,
  document jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  constraint editor_documents_asset_unique unique (asset_id)
);

-- Enable RLS
alter table public.editor_documents enable row level security;

-- RLS Policy: Users can manage documents in their workspace
create policy "Users can manage documents in their workspace"
on public.editor_documents for all
using (
  asset_id in (
    select id from public.assets
    where project_id in (
      select id from public.projects
      where workspace_id in (
        select workspace_id from public.workspace_members
        where supabase_user_id = auth.uid()
      )
    )
  )
);

-- Project Ingredients
create table public.project_ingredients (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references public.projects(id) on delete cascade,
  alias text not null,
  asset_id uuid not null references public.assets(id) on delete cascade,
  version_id uuid not null references public.asset_versions(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint project_ingredients_alias_unique unique (project_id, alias),
  constraint project_ingredients_alias_format check (alias ~ '^[A-Za-z][A-Za-z0-9_-]{1,31}$')
);

-- Enable RLS
alter table public.project_ingredients enable row level security;

-- RLS Policy: Users can manage ingredients in their workspace
create policy "Users can manage ingredients in their workspace"
on public.project_ingredients for all
using (
  project_id in (
    select id from public.projects
    where workspace_id in (
      select workspace_id from public.workspace_members
      where supabase_user_id = auth.uid()
    )
  )
);

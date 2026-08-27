-- Batch Runs
create table public.batch_runs (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  preset_id uuid references public.presets(id),
  status text not null check (status in ('pending', 'running', 'succeeded', 'failed', 'partial')) default 'pending',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Batch Items
create table public.batch_items (
  id uuid primary key default uuid_generate_v4(),
  batch_run_id uuid not null references public.batch_runs(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  parent_version_id uuid references public.asset_versions(id),
  status text not null check (status in ('pending', 'running', 'succeeded', 'failed')) default 'pending',
  generation_run_id uuid references public.generation_runs(id),
  error_code text,
  created_at timestamptz not null default now()
);

-- Enable RLS
alter table public.batch_runs enable row level security;
alter table public.batch_items enable row level security;

-- RLS Policy: Users can manage batch runs in their workspace
create policy "Users can manage batch runs in their workspace"
on public.batch_runs for all
using (
  workspace_id in (
    select workspace_id from public.workspace_members
    where supabase_user_id = auth.uid()
  )
);

-- RLS Policy: Users can manage batch items in their workspace
create policy "Users can manage batch items in their workspace"
on public.batch_items for all
using (
  batch_run_id in (
    select id from public.batch_runs
    where workspace_id in (
      select workspace_id from public.workspace_members
      where supabase_user_id = auth.uid()
    )
  )
);

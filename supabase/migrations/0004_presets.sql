-- Presets
create table public.presets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('generation', 'edit', 'document')),
  definition jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.presets enable row level security;

-- RLS Policy: Users can manage presets in their workspace
create policy "Users can manage presets in their workspace"
on public.presets for all
using (
  workspace_id in (
    select workspace_id from public.workspace_members
    where supabase_user_id = auth.uid()
  )
);

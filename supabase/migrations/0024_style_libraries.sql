-- Create style_libraries table for grouping styles within a workspace.
-- Styles can belong to one library or be ungrouped (library_id = NULL).

create table public.style_libraries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index style_libraries_workspace_idx on public.style_libraries(workspace_id);

alter table public.styles
  add column library_id uuid references public.style_libraries(id) on delete set null;

-- RLS: same pattern as styles table
alter table public.style_libraries enable row level security;
create policy "Users can manage style libraries in their workspace" on public.style_libraries
  for all to authenticated
  using (workspace_id in (select public.current_workspace_ids()))
  with check (workspace_id in (select public.current_workspace_ids()));

-- updated_at trigger reuse
create trigger style_libraries_set_updated_at before update on public.style_libraries
for each row execute function public.set_updated_at();

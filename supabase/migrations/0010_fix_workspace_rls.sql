create or replace function public.current_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select workspace_id
  from public.workspace_members
  where supabase_user_id = auth.uid();
$$;

revoke all on function public.current_workspace_ids() from public, anon;
grant execute on function public.current_workspace_ids() to authenticated;

-- Replace the recursive workspace/member policies.
drop policy if exists "Users can view their workspace" on public.workspaces;
create policy "Users can view their workspace"
on public.workspaces for select
using (id in (select public.current_workspace_ids()));

drop policy if exists "Users can view workspace members" on public.workspace_members;
create policy "Users can view workspace members"
on public.workspace_members for select
using (workspace_id in (select public.current_workspace_ids()));

-- Replace policies that referenced workspace_members directly.
drop policy if exists "Users can manage projects in their workspace" on public.projects;
create policy "Users can manage projects in their workspace"
on public.projects for all
using (workspace_id in (select public.current_workspace_ids()))
with check (workspace_id in (select public.current_workspace_ids()));

drop policy if exists "Users can manage assets in their workspace" on public.assets;
create policy "Users can manage assets in their workspace"
on public.assets for all
using (
  project_id in (
    select id from public.projects
    where workspace_id in (select public.current_workspace_ids())
  )
)
with check (
  project_id in (
    select id from public.projects
    where workspace_id in (select public.current_workspace_ids())
  )
);

drop policy if exists "Users can manage asset versions in their workspace" on public.asset_versions;
create policy "Users can manage asset versions in their workspace"
on public.asset_versions for all
using (
  asset_id in (
    select id from public.assets
    where project_id in (
      select id from public.projects
      where workspace_id in (select public.current_workspace_ids())
    )
  )
)
with check (
  asset_id in (
    select id from public.assets
    where project_id in (
      select id from public.projects
      where workspace_id in (select public.current_workspace_ids())
    )
  )
);

drop policy if exists "Users can manage generation runs in their workspace" on public.generation_runs;
create policy "Users can manage generation runs in their workspace"
on public.generation_runs for all
using (workspace_id in (select public.current_workspace_ids()))
with check (workspace_id in (select public.current_workspace_ids()));

drop policy if exists "Users can manage ingredients in their workspace" on public.project_ingredients;
create policy "Users can manage ingredients in their workspace"
on public.project_ingredients for all
using (
  project_id in (
    select id from public.projects
    where workspace_id in (select public.current_workspace_ids())
  )
)
with check (
  project_id in (
    select id from public.projects
    where workspace_id in (select public.current_workspace_ids())
  )
);

drop policy if exists "Users can manage documents in their workspace" on public.editor_documents;
create policy "Users can manage documents in their workspace"
on public.editor_documents for all
using (
  asset_id in (
    select id from public.assets
    where project_id in (
      select id from public.projects
      where workspace_id in (select public.current_workspace_ids())
    )
  )
)
with check (
  asset_id in (
    select id from public.assets
    where project_id in (
      select id from public.projects
      where workspace_id in (select public.current_workspace_ids())
    )
  )
);

drop policy if exists "Users can manage presets in their workspace" on public.presets;
create policy "Users can manage presets in their workspace"
on public.presets for all
using (workspace_id in (select public.current_workspace_ids()))
with check (workspace_id in (select public.current_workspace_ids()));

drop policy if exists "Users can manage batch runs in their workspace" on public.batch_runs;
create policy "Users can manage batch runs in their workspace"
on public.batch_runs for all
using (workspace_id in (select public.current_workspace_ids()))
with check (workspace_id in (select public.current_workspace_ids()));

drop policy if exists "Users can manage batch items in their workspace" on public.batch_items;
create policy "Users can manage batch items in their workspace"
on public.batch_items for all
using (
  batch_run_id in (
    select id from public.batch_runs
    where workspace_id in (select public.current_workspace_ids())
  )
)
with check (
  batch_run_id in (
    select id from public.batch_runs
    where workspace_id in (select public.current_workspace_ids())
  )
);

-- Replace broad authenticated policies with workspace-scoped storage access.
-- Upload path convention: {workspace_id}/styles/{style_id}/{reference_id}.{ext}

-- Drop unsafe broad policies
drop policy if exists "Authenticated read access" on storage.objects;
drop policy if exists "Authenticated insert access" on storage.objects;

-- Workspace-scoped read: user must be member of workspace that owns the prefix
create policy "workspace_read_access" on storage.objects
for select to authenticated
using (
  bucket_id = 'assets'
  and (
    -- Path starts with workspace_id the user is member of
    split_part(name, '/', 1) in (select public.current_workspace_ids()::text)
  )
);

-- Workspace-scoped insert: same ownership check
create policy "workspace_insert_access" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'assets'
  and (
    split_part(name, '/', 1) in (select public.current_workspace_ids()::text)
  )
);

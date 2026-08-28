-- Drop the old trigger first
drop trigger if exists on_auth_user_created on auth.users;

-- Drop the old function
drop function if exists public.handle_new_user();

-- Create improved trigger function that handles existing workspace_members rows
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace_id uuid;
  v_owner_email text := lower(trim(new.email));
  v_existing_member record;
begin
  -- Find or create workspace
  select id into v_workspace_id
  from public.workspaces
  order by created_at
  limit 1;

  if v_workspace_id is null then
    insert into public.workspaces (name)
    values ('SeniorStudio')
    returning id into v_workspace_id;
  end if;

  -- Check if member already exists (e.g. created by Auth0 MCP flow)
  select * into v_existing_member
  from public.workspace_members
  where lower(email) = v_owner_email
  limit 1;

  if found then
    -- Member exists, just link the supabase_user_id
    update public.workspace_members
    set supabase_user_id = new.id
    where id = v_existing_member.id
      and supabase_user_id is null;
    return new;
  end if;

  -- New member, insert
  insert into public.workspace_members (
    workspace_id,
    email,
    supabase_user_id
  ) values (
    v_workspace_id,
    v_owner_email,
    new.id
  );

  return new;
end;
$$;

-- Recreate trigger
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

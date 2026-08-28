create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  workspace_id uuid;
  owner_email text := lower(trim(new.email));
begin
  select id into workspace_id
  from public.workspaces
  order by created_at
  limit 1;

  if workspace_id is null then
    insert into public.workspaces (name)
    values ('SeniorStudio')
    returning id into workspace_id;
  end if;

  insert into public.workspace_members (
    workspace_id,
    email,
    supabase_user_id
  ) values (
    workspace_id,
    owner_email,
    new.id
  )
  on conflict (supabase_user_id) do update
    set email = excluded.email;

  return new;
end;
$$;

-- The trigger may already exist from 0001; recreate it with the fixed function.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

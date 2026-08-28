create unique index if not exists workspace_members_email_lower_unique
  on public.workspace_members (lower(email));

create or replace function public.bootstrap_owner_workspace(
  p_email text,
  p_supabase_user_id uuid default null,
  p_auth0_sub text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text := lower(trim(p_email));
  member_row public.workspace_members%rowtype;
  target_workspace_id uuid;
begin
  if normalized_email = '' then
    raise exception 'Owner email is required';
  end if;

  perform pg_advisory_xact_lock(hashtext('seniorstudio-owner-workspace'));

  select * into member_row
  from public.workspace_members
  where lower(email) = normalized_email
  limit 1;

  if found then
    if member_row.supabase_user_id is not null
       and p_supabase_user_id is not null
       and member_row.supabase_user_id <> p_supabase_user_id then
      raise exception 'Supabase identity conflict';
    end if;

    if member_row.auth0_sub is not null
       and p_auth0_sub is not null
       and member_row.auth0_sub <> p_auth0_sub then
      raise exception 'Auth0 identity conflict';
    end if;

    update public.workspace_members
    set supabase_user_id = coalesce(supabase_user_id, p_supabase_user_id),
        auth0_sub = coalesce(auth0_sub, p_auth0_sub)
    where id = member_row.id;

    return member_row.workspace_id;
  end if;

  select id into target_workspace_id
  from public.workspaces
  order by created_at
  limit 1;

  if target_workspace_id is null then
    insert into public.workspaces (name)
    values ('SeniorStudio')
    returning id into target_workspace_id;
  end if;

  insert into public.workspace_members (
    workspace_id,
    email,
    supabase_user_id,
    auth0_sub
  ) values (
    target_workspace_id,
    normalized_email,
    p_supabase_user_id,
    p_auth0_sub
  );

  return target_workspace_id;
end;
$$;

revoke all on function public.bootstrap_owner_workspace(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.bootstrap_owner_workspace(text, uuid, text)
  to service_role;

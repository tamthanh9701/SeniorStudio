alter table public.workspace_members
  add column if not exists auth0_sub text unique;

create index if not exists workspace_members_email_lower_idx
  on public.workspace_members (lower(email));

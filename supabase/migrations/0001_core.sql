-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- Workspaces
create table public.workspaces (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  created_at timestamptz not null default now()
);

-- Workspace Members
create table public.workspace_members (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  supabase_user_id uuid unique,
  auth0_sub text unique,
  created_at timestamptz not null default now()
);

-- Projects
create table public.projects (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Assets
create table public.assets (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('generated', 'uploaded')),
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Asset Versions
create table public.asset_versions (
  id uuid primary key default uuid_generate_v4(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  parent_version_id uuid references public.asset_versions(id),
  source text not null check (source in ('chatgpt', 'web_openai', 'upload', 'flattened')),
  storage_path text not null,
  mime_type text not null,
  width integer not null,
  height integer not null,
  byte_size integer not null,
  prompt text,
  provider_response_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Add foreign key from assets.current_version_id to asset_versions
alter table public.assets add constraint assets_current_version_id_fkey
  foreign key (current_version_id) references public.asset_versions(id);

-- Add constraint: parent_version_id must belong to same asset
alter table public.asset_versions add constraint asset_versions_parent_version_check
  check (
    parent_version_id is null or
    asset_id = (select asset_id from public.asset_versions where id = parent_version_id)
  );

-- Generation Runs
create table public.generation_runs (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  asset_id uuid references public.assets(id),
  parent_version_id uuid,
  origin text not null check (origin in ('chatgpt_mcp', 'web')),
  operation text not null check (operation in ('generate', 'edit')),
  status text not null check (status in ('pending', 'succeeded', 'failed')) default 'pending',
  openai_response_id text,
  request jsonb not null default '{}',
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Service Heartbeats
create table public.service_heartbeats (
  service text primary key,
  last_seen_at timestamptz not null default now()
);

-- Create Storage Bucket
insert into storage.buckets (id, name, public) values ('assets', 'assets', false);

-- Storage Policy: Authenticated read access
create policy "Authenticated read access"
on storage.objects for select
using (bucket_id = 'assets' and auth.role() = 'authenticated');

-- Storage Policy: Authenticated insert access
create policy "Authenticated insert access"
on storage.objects for insert
with check (bucket_id = 'assets' and auth.role() = 'authenticated');

-- Enable RLS on all tables
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.projects enable row level security;
alter table public.assets enable row level security;
alter table public.asset_versions enable row level security;
alter table public.generation_runs enable row level security;
alter table public.service_heartbeats enable row level security;

-- RLS Policies: workspace_members can manage their workspace
create policy "Users can view their workspace"
on public.workspaces for select
using (
  id in (
    select workspace_id from public.workspace_members
    where supabase_user_id = auth.uid()
  )
);

create policy "Users can view workspace members"
on public.workspace_members for select
using (
  workspace_id in (
    select workspace_id from public.workspace_members
    where supabase_user_id = auth.uid()
  )
);

create policy "Users can manage projects in their workspace"
on public.projects for all
using (
  workspace_id in (
    select workspace_id from public.workspace_members
    where supabase_user_id = auth.uid()
  )
);

create policy "Users can manage assets in their workspace"
on public.assets for all
using (
  project_id in (
    select id from public.projects
    where workspace_id in (
      select workspace_id from public.workspace_members
      where supabase_user_id = auth.uid()
    )
  )
);

create policy "Users can manage asset versions in their workspace"
on public.asset_versions for all
using (
  asset_id in (
    select id from public.assets
    where project_id in (
      select id from public.projects
      where workspace_id in (
        select workspace_id from public.workspace_members
        where supabase_user_id = auth.uid()
      )
    )
  )
);

create policy "Users can manage generation runs in their workspace"
on public.generation_runs for all
using (
  workspace_id in (
    select workspace_id from public.workspace_members
    where supabase_user_id = auth.uid()
  )
);

-- Service heartbeats: only service role can manage
create policy "Service role can manage heartbeats"
on public.service_heartbeats for all
using (auth.role() = 'service_role');

-- Function to create workspace member on first login
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.workspace_members (workspace_id, email, supabase_user_id)
  select id, new.email, new.id
  from public.workspaces
  limit 1;
  return new;
end;
$$ language plpgsql security definer;

-- Trigger to create workspace member on signup
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

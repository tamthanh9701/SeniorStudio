-- 0025_style_interactive_features.sql
-- Adds interactive features: quota, schema versions, clarification support

-- ai_usage_quota
create table if not exists public.ai_usage_quota (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  route_group text not null check (route_group in ('brain', 'image')),
  count integer not null default 0,
  primary key (user_id, day, route_group)
);
alter table public.ai_usage_quota enable row level security;
create policy "users read own usage" on public.ai_usage_quota
  for select to authenticated
  using (user_id = auth.uid());

-- styles new columns
alter table public.styles
  add column if not exists clarification_questions jsonb,
  add column if not exists clarification_answers jsonb,
  add column if not exists operability jsonb,
  add column if not exists last_fidelity jsonb;

-- style_schema_versions
create table if not exists public.style_schema_versions (
  id uuid primary key default gen_random_uuid(),
  style_id uuid not null references public.styles(id) on delete cascade,
  source text not null check (source in ('analysis', 'user_validation', 'tuning', 'manual')),
  schema jsonb not null,
  fingerprint jsonb,
  invariant_contract jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index style_schema_versions_style_idx on public.style_schema_versions(style_id, created_at desc);
alter table public.style_schema_versions enable row level security;
create policy "Users can manage schema versions in their workspace" on public.style_schema_versions
  for all to authenticated
  using (exists (select 1 from public.styles s where s.id = style_id
    and s.workspace_id in (select public.current_workspace_ids())))
  with check (exists (select 1 from public.styles s where s.id = style_id
    and s.workspace_id in (select public.current_workspace_ids())));

-- Keep last 20 versions per style (trigger)
create or replace function public.trim_style_schema_versions()
returns trigger language plpgsql as $$
begin
  delete from public.style_schema_versions
  where style_id = NEW.style_id and id not in (
    select id from public.style_schema_versions
    where style_id = NEW.style_id
    order by created_at desc limit 20
  );
  return NEW;
end; $$;

create trigger trim_style_schema_versions_trigger
  after insert on public.style_schema_versions
  for each row execute function public.trim_style_schema_versions();

-- 0030_workspace_hard_quota.sql
-- Atomic hard quota per workspace/day with reservation/charge/release lifecycle.
-- Depends on 0029_security_runtime_corrections.sql.

-- Workspace-level quota limits (operator-configurable).
create table if not exists public.workspace_ai_limits (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  image_limit integer not null default 100,
  brain_limit integer not null default 200,
  check (image_limit >= 0),
  check (brain_limit >= 0)
);
alter table public.workspace_ai_limits enable row level security;
create policy "workspace limits read" on public.workspace_ai_limits
  for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));

-- Per-workspace per-day usage accounting (replaces legacy per-user quota).
create table if not exists public.workspace_ai_usage (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  day date not null,
  route_group text not null check (route_group in ('brain', 'image')),
  held integer not null default 0,
  charged integer not null default 0,
  primary key (workspace_id, day, route_group)
);
alter table public.workspace_ai_usage enable row level security;
create policy "workspace usage read" on public.workspace_ai_usage
  for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));

-- Granular reservation tracking for atomic reserve/charge/release.
create table if not exists public.ai_quota_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  day date not null,
  route_group text not null check (route_group in ('brain', 'image')),
  units integer not null check (units > 0),
  state text not null check (state in ('reserved', 'charged', 'released')),
  job_id uuid unique references public.ai_jobs(id) on delete set null,
  created_at timestamptz not null default now(),
  charged_at timestamptz
);
-- job_id FK: ON DELETE SET NULL preserves accounting row when job is deleted.
alter table public.ai_quota_reservations enable row level security;
create policy "workspace reservation read" on public.ai_quota_reservations
  for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));

-- Backfill workspace_ai_limits for existing workspaces.
insert into public.workspace_ai_limits (workspace_id)
select id from public.workspaces
on conflict do nothing;

-- Internal SQL helpers (service-role only).
create or replace function public.reserve_ai_quota(
  p_workspace_id uuid,
  p_route_group text,
  p_units integer,
  p_job_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_limit integer;
  v_day date := (now() at time zone 'utc')::date;
  v_held integer;
  v_charged integer;
  v_reservation_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  -- Get workspace limit
  select case when p_route_group = 'image' then image_limit else brain_limit end
  into v_limit
  from public.workspace_ai_limits
  where workspace_id = p_workspace_id;

  if v_limit is null then
    -- No limits row; insert default and use it
    insert into public.workspace_ai_limits (workspace_id) values (p_workspace_id)
    on conflict do nothing;
    v_limit := case when p_route_group = 'image' then 100 else 200 end;
  end if;

  if v_limit = 0 then
    raise exception 'quota_exceeded' using errcode = 'P0001';
  end if;

  -- Ensure usage row exists
  insert into public.workspace_ai_usage (workspace_id, day, route_group)
  values (p_workspace_id, v_day, p_route_group)
  on conflict do nothing;

  -- Lock usage row and check
  select held, charged into v_held, v_charged
  from public.workspace_ai_usage
  where workspace_id = p_workspace_id and day = v_day and route_group = p_route_group
  for update;

  if (coalesce(v_held, 0) + coalesce(v_charged, 0) + p_units) > v_limit then
    raise exception 'quota_exceeded' using errcode = 'P0001';
  end if;

  -- Create reservation and update held atomically
  insert into public.ai_quota_reservations (workspace_id, day, route_group, units, state, job_id)
  values (p_workspace_id, v_day, p_route_group, p_units, 'reserved', p_job_id)
  returning id into v_reservation_id;

  update public.workspace_ai_usage
  set held = held + p_units
  where workspace_id = p_workspace_id and day = v_day and route_group = p_route_group;

  return v_reservation_id;
end;
$$;

create or replace function public.begin_ai_provider(p_reservation_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_reservation record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select * into v_reservation
  from public.ai_quota_reservations
  where id = p_reservation_id and state = 'reserved'
  for update;

  if v_reservation.id is null then
    raise exception 'PROVIDER_ALREADY_STARTED' using errcode = '22023';
  end if;

  update public.ai_quota_reservations
  set state = 'charged', charged_at = now()
  where id = p_reservation_id;

  update public.workspace_ai_usage
  set held = held - v_reservation.units, charged = charged + v_reservation.units
  where workspace_id = v_reservation.workspace_id
    and day = v_reservation.day
    and route_group = v_reservation.route_group;
end;
$$;

create or replace function public.release_ai_reservation(p_reservation_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_reservation record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select * into v_reservation
  from public.ai_quota_reservations
  where id = p_reservation_id and state = 'reserved'
  for update;

  if v_reservation.id is null then
    return; -- Already released or charged; idempotent
  end if;

  update public.ai_quota_reservations
  set state = 'released'
  where id = p_reservation_id;

  update public.workspace_ai_usage
  set held = held - v_reservation.units
  where workspace_id = v_reservation.workspace_id
    and day = v_reservation.day
    and route_group = v_reservation.route_group;
end;
$$;

-- Revoke and grant: authenticated read-only; service_role for mutations.
revoke all on function public.reserve_ai_quota(uuid, text, integer, uuid) from public, anon, authenticated;
grant execute on function public.reserve_ai_quota(uuid, text, integer, uuid) to service_role;
revoke all on function public.begin_ai_provider(uuid) from public, anon, authenticated;
grant execute on function public.begin_ai_provider(uuid) to service_role;
revoke all on function public.release_ai_reservation(uuid) from public, anon, authenticated;
grant execute on function public.release_ai_reservation(uuid) to service_role;

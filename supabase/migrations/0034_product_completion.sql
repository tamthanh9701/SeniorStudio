-- 0034_product_completion.sql
-- Forward-only hardening for quota reservations, service job lifecycle, ownership,
-- reference/source guards, and persistence resolution. 0028-0033 remain immutable.

-- Reservation accounting must update held under the same usage-row lock.
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
  v_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if p_route_group not in ('image','brain') or p_units is null or p_units <= 0
     or not exists (select 1 from public.workspaces where id = p_workspace_id) then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if p_job_id is not null and not exists (select 1 from public.ai_jobs where id=p_job_id and workspace_id=p_workspace_id) then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0002';
  end if;
  select case when p_route_group='image' then image_limit else brain_limit end
    into v_limit from public.workspace_ai_limits where workspace_id=p_workspace_id for update;
  if v_limit is null then
    insert into public.workspace_ai_limits(workspace_id) values(p_workspace_id) on conflict do nothing;
    select case when p_route_group='image' then image_limit else brain_limit end
      into v_limit from public.workspace_ai_limits where workspace_id=p_workspace_id for update;
  end if;
  insert into public.workspace_ai_usage(workspace_id,day,route_group,held,charged)
    values(p_workspace_id,v_day,p_route_group,0,0) on conflict do nothing;
  select held,charged into v_held,v_charged
    from public.workspace_ai_usage
    where workspace_id=p_workspace_id and day=v_day and route_group=p_route_group for update;
  if coalesce(v_held,0)+coalesce(v_charged,0)+p_units > v_limit then
    raise exception 'quota_exceeded' using errcode='P0001';
  end if;
  insert into public.ai_quota_reservations(workspace_id,day,route_group,units,state,job_id)
    values(p_workspace_id,v_day,p_route_group,p_units,'reserved',p_job_id)
    returning id into v_id;
  update public.workspace_ai_usage set held=held+p_units
    where workspace_id=p_workspace_id and day=v_day and route_group=p_route_group;
  return v_id;
end; $$;

-- Brain reservation is the same atomic lifecycle, including held accounting.
create or replace function public.reserve_brain_quota(p_workspace_id uuid, p_reservation_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_limit integer; v_day date := (now() at time zone 'utc')::date; v_held integer; v_charged integer;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from public.workspaces where id = p_workspace_id) then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  select brain_limit into v_limit from public.workspace_ai_limits where workspace_id=p_workspace_id for update;
  if v_limit is null then insert into public.workspace_ai_limits(workspace_id) values(p_workspace_id) on conflict do nothing; select brain_limit into v_limit from public.workspace_ai_limits where workspace_id=p_workspace_id for update; end if;
  insert into public.workspace_ai_usage(workspace_id,day,route_group,held,charged) values(p_workspace_id,v_day,'brain',0,0) on conflict do nothing;
  select held,charged into v_held,v_charged from public.workspace_ai_usage where workspace_id=p_workspace_id and day=v_day and route_group='brain' for update;
  if coalesce(v_held,0)+coalesce(v_charged,0)+1 > v_limit then raise exception 'quota_exceeded' using errcode='P0001'; end if;
  insert into public.ai_quota_reservations(id,workspace_id,day,route_group,units,state) values(p_reservation_id,p_workspace_id,v_day,'brain',1,'reserved');
  update public.workspace_ai_usage set held=held+1 where workspace_id=p_workspace_id and day=v_day and route_group='brain';
end; $$;

-- Explicit service-only linkage closes the reservation/job circularity safely.
create or replace function public.attach_ai_quota_reservation(p_job_id uuid, p_reservation_id uuid)
returns public.ai_jobs language plpgsql security definer set search_path=public as $$
declare j public.ai_jobs; r public.ai_quota_reservations;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode='42501'; end if;
  select * into j from public.ai_jobs where id=p_job_id for update;
  if j.id is null then raise exception 'JOB_NOT_FOUND' using errcode='P0002'; end if;
  select * into r from public.ai_quota_reservations where id=p_reservation_id for update;
  if r.id is null or r.state<>'reserved' or r.job_id is not null or r.workspace_id<>j.workspace_id or r.route_group<>'image' then
    raise exception 'RESERVATION_INVALID' using errcode='22023';
  end if;
  if r.units <> greatest(1,coalesce((j.input->>'count')::integer,1)) then raise exception 'RESERVATION_INVALID' using errcode='22023'; end if;
  update public.ai_quota_reservations set job_id=j.id where id=r.id;
  update public.ai_jobs set quota_reservation_id=r.id,updated_at=now() where id=j.id returning * into j;
  return j;
end; $$;
revoke all on function public.attach_ai_quota_reservation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.attach_ai_quota_reservation(uuid,uuid) to service_role;

-- Prevent mismatched reservation linkage, including direct service writes.
create or replace function public.validate_ai_job_reservation()
returns trigger language plpgsql security definer set search_path=public as $$
declare r public.ai_quota_reservations;
begin
  if new.quota_reservation_id is null then return new; end if;
  select * into r from public.ai_quota_reservations where id=new.quota_reservation_id;
  if r.id is null or r.workspace_id<>new.workspace_id or r.route_group<>'image' or r.job_id<>new.id then raise exception 'RESERVATION_INVALID' using errcode='22023'; end if;
  return new;
end; $$;
do $$ begin
  if not exists(select 1 from pg_trigger where tgname='validate_ai_job_reservation_trigger') then
    create trigger validate_ai_job_reservation_trigger before insert or update on public.ai_jobs for each row execute function public.validate_ai_job_reservation();
  end if;
end $$;

-- Strict path validation uses path segments, not substring matches, and applies updates.
create or replace function public.validate_asset_version_path()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from unnest(string_to_array(trim(both '/' from new.storage_path),'/')) s where s=new.asset_id::text) then raise exception 'INVALID_STORAGE_PATH' using errcode='22023'; end if;
  if new.mime_type not in ('image/png','image/jpeg','image/webp') or new.width<=0 or new.height<=0 or new.byte_size<=0 or new.byte_size>52428800 then raise exception 'UNSUPPORTED_IMAGE' using errcode='22023'; end if;
  return new;
end; $$;
create or replace function public.validate_style_reference_path()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  -- Workspace/style segments must exist in path; reference filename must match
  -- either the bare id (legacy) or {id}.{ext} (canonical storage format).
  if not exists(select 1 from unnest(string_to_array(trim(both '/' from new.storage_path),'/')) s where s=new.style_id::text)
     or not (
       exists(select 1 from unnest(string_to_array(trim(both '/' from new.storage_path),'/')) s where s=new.id::text)
       or new.storage_path ~ ('/' || new.style_id::text || '/[^/]*\.(png|jpg|jpeg|webp)$')
     ) then raise exception 'INVALID_STORAGE_PATH' using errcode = '22023'; end if;
  return new;
end; $$;
create or replace function public.validate_job_input_path()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from unnest(string_to_array(trim(both '/' from new.storage_path),'/')) s where s=new.workspace_id::text)
     or not exists(select 1 from unnest(string_to_array(trim(both '/' from new.storage_path),'/')) s where s=new.id::text) then raise exception 'INVALID_STORAGE_PATH' using errcode='22023'; end if;
  return new;
end; $$;

do $$ begin
  if not exists(select 1 from pg_trigger where tgname='validate_asset_version_path_update_trigger') then create trigger validate_asset_version_path_update_trigger before insert or update on public.asset_versions for each row execute function public.validate_asset_version_path(); end if;
  if not exists(select 1 from pg_trigger where tgname='validate_style_reference_path_update_trigger') then create trigger validate_style_reference_path_update_trigger before insert or update on public.style_references for each row execute function public.validate_style_reference_path(); end if;
  if not exists(select 1 from pg_trigger where tgname='validate_job_input_path_update_trigger') then create trigger validate_job_input_path_update_trigger before insert or update on public.ai_job_inputs for each row execute function public.validate_job_input_path(); end if;
end $$;

-- Reservation release/charge remain idempotent and never underflow usage.
create or replace function public.release_ai_reservation(p_reservation_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare r public.ai_quota_reservations; n integer;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode='42501'; end if;
  select * into r from public.ai_quota_reservations where id=p_reservation_id and state='reserved' for update;
  if r.id is null then return; end if;
  update public.ai_quota_reservations set state='released' where id=r.id;
  update public.workspace_ai_usage set held=greatest(0,held-r.units) where workspace_id=r.workspace_id and day=r.day and route_group=r.route_group;
end; $$;

-- Exact grants: no client can mutate lifecycle or linkage RPCs.
revoke all on function public.reserve_ai_quota(uuid,text,integer,uuid),public.reserve_brain_quota(uuid,uuid),public.attach_ai_quota_reservation(uuid,uuid),public.begin_ai_provider(uuid),public.release_ai_reservation(uuid),public.begin_brain_operation(uuid),public.release_brain_reservation(uuid) from public,anon,authenticated;
grant execute on function public.reserve_ai_quota(uuid,text,integer,uuid),public.reserve_brain_quota(uuid,uuid),public.attach_ai_quota_reservation(uuid,uuid),public.begin_ai_provider(uuid),public.release_ai_reservation(uuid),public.begin_brain_operation(uuid),public.release_brain_reservation(uuid) to service_role;

-- Internal helpers have no JWT-role branch. They are not exposed to API roles;
-- authenticated enqueue functions call them inside the same transaction.
create or replace function public.reserve_ai_quota_internal(
  p_workspace_id uuid, p_route_group text, p_units integer
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_limit integer;
  v_day date := (now() at time zone 'utc')::date;
  v_held integer;
  v_charged integer;
  v_id uuid;
begin
  if p_route_group not in ('image','brain') or p_units is null or p_units <= 0
     or not exists (select 1 from public.workspaces where id=p_workspace_id) then
    raise exception 'INVALID_REQUEST' using errcode='22023';
  end if;
  select case when p_route_group='image' then image_limit else brain_limit end
    into v_limit from public.workspace_ai_limits where workspace_id=p_workspace_id for update;
  if v_limit is null then
    insert into public.workspace_ai_limits(workspace_id) values(p_workspace_id) on conflict do nothing;
    select case when p_route_group='image' then image_limit else brain_limit end
      into v_limit from public.workspace_ai_limits where workspace_id=p_workspace_id for update;
  end if;
  insert into public.workspace_ai_usage(workspace_id,day,route_group,held,charged)
    values(p_workspace_id,v_day,p_route_group,0,0) on conflict do nothing;
  select held,charged into v_held,v_charged from public.workspace_ai_usage
    where workspace_id=p_workspace_id and day=v_day and route_group=p_route_group for update;
  if coalesce(v_held,0)+coalesce(v_charged,0)+p_units > v_limit then
    raise exception 'quota_exceeded' using errcode='P0001';
  end if;
  insert into public.ai_quota_reservations(workspace_id,day,route_group,units,state)
    values(p_workspace_id,v_day,p_route_group,p_units,'reserved') returning id into v_id;
  update public.workspace_ai_usage set held=held+p_units
    where workspace_id=p_workspace_id and day=v_day and route_group=p_route_group;
  return v_id;
end; $$;

create or replace function public.attach_ai_quota_reservation_internal(
  p_job_id uuid, p_reservation_id uuid
) returns public.ai_jobs language plpgsql security definer set search_path=public as $$
declare j public.ai_jobs; r public.ai_quota_reservations;
begin
  select * into j from public.ai_jobs where id=p_job_id for update;
  select * into r from public.ai_quota_reservations where id=p_reservation_id for update;
  if j.id is null or r.id is null or r.state<>'reserved' or r.job_id is not null
     or r.workspace_id<>j.workspace_id or r.route_group<>'image'
     or r.units<>greatest(1,coalesce((j.input->>'count')::integer,1)) then
    raise exception 'RESERVATION_INVALID' using errcode='22023';
  end if;
  update public.ai_quota_reservations set job_id=j.id where id=r.id;
  update public.ai_jobs set quota_reservation_id=r.id,updated_at=now()
    where id=j.id returning * into j;
  return j;
end; $$;

revoke all on function public.reserve_ai_quota_internal(uuid,text,integer) from public,anon,authenticated;
revoke all on function public.attach_ai_quota_reservation_internal(uuid,uuid) from public,anon,authenticated;

create or replace function public.enqueue_text_to_image_job_v2(
  p_workspace_id uuid, p_project_id uuid, p_requested_by uuid,
  p_provider text, p_model text, p_prompt text, p_count integer, p_size text,
  p_quality text, p_style_id uuid default null, p_original_prompt text default null,
  p_module text default 'projects', p_cost_mode text default null,
  p_requested_model_id text default null, p_reference_ids uuid[] default '{}',
  p_temperature numeric default null
) returns public.ai_jobs language plpgsql security definer set search_path=public as $$
declare v_reservation_id uuid; v_job public.ai_jobs;
begin
  v_reservation_id := public.reserve_ai_quota_internal(p_workspace_id,'image',p_count);
  v_job := public.enqueue_text_to_image_job(
    p_workspace_id,p_project_id,p_requested_by,p_provider,p_model,p_prompt,p_count,p_size,
    p_quality,p_style_id,p_original_prompt,p_module,p_cost_mode,p_requested_model_id,
    p_reference_ids,p_temperature);
  return public.attach_ai_quota_reservation_internal(v_job.id,v_reservation_id);
end; $$;
revoke all on function public.enqueue_text_to_image_job_v2(uuid,uuid,uuid,text,text,text,integer,text,text,uuid,text,text,text,text,uuid[],numeric) from public,anon;
grant execute on function public.enqueue_text_to_image_job_v2(uuid,uuid,uuid,text,text,text,integer,text,text,uuid,text,text,text,text,uuid[],numeric) to authenticated;

create or replace function public.enqueue_image_to_image_job_v2(
  p_workspace_id uuid, p_requested_by uuid, p_provider text, p_model text,
  p_prompt text, p_count integer, p_size text, p_quality text,
  p_style_id uuid, p_source_version_id uuid,
  p_original_prompt text default null, p_cost_mode text default 'strict_style',
  p_requested_model_id text default null, p_reference_ids uuid[] default '{}',
  p_temperature numeric default null
) returns public.ai_jobs language plpgsql security definer set search_path=public as $$
declare v_reservation_id uuid; v_job public.ai_jobs;
begin
  v_reservation_id := public.reserve_ai_quota_internal(p_workspace_id,'image',p_count);
  v_job := public.enqueue_image_to_image_job(
    p_workspace_id,p_requested_by,p_provider,p_model,p_prompt,p_count,p_size,p_quality,
    p_style_id,p_source_version_id,p_original_prompt,p_cost_mode,p_requested_model_id,
    p_reference_ids,p_temperature);
  return public.attach_ai_quota_reservation_internal(v_job.id,v_reservation_id);
end; $$;
revoke all on function public.enqueue_image_to_image_job_v2(uuid,uuid,text,text,text,integer,text,text,uuid,uuid,text,text,text,uuid[],numeric) from public,anon;
grant execute on function public.enqueue_image_to_image_job_v2(uuid,uuid,text,text,text,integer,text,text,uuid,uuid,text,text,text,uuid[],numeric) to authenticated;

create or replace function public.enqueue_inpaint_job_v2(
  p_mask_id uuid, p_requested_by uuid, p_provider text, p_model text,
  p_prompt text, p_quality text
) returns public.ai_jobs language plpgsql security definer set search_path=public as $$
declare v_workspace_id uuid; v_reservation_id uuid; v_job public.ai_jobs;
begin
  if auth.role()<>'authenticated' or auth.uid()<>p_requested_by then
    raise exception 'NOT_FOUND' using errcode='P0002';
  end if;
  select workspace_id into v_workspace_id from public.ai_job_inputs
    where id=p_mask_id and job_id is null and expires_at>now() for update;
  if v_workspace_id is null or v_workspace_id not in (select public.current_workspace_ids()) then
    raise exception 'NOT_FOUND' using errcode='P0002';
  end if;
  v_reservation_id := public.reserve_ai_quota_internal(v_workspace_id,'image',1);
  v_job := public.enqueue_inpaint_job(p_mask_id,p_requested_by,p_provider,p_model,p_prompt,p_quality);
  return public.attach_ai_quota_reservation_internal(v_job.id,v_reservation_id);
end; $$;
revoke all on function public.enqueue_inpaint_job_v2(uuid,uuid,text,text,text,text) from public,anon;
grant execute on function public.enqueue_inpaint_job_v2(uuid,uuid,text,text,text,text) to authenticated;

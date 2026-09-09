-- Runtime reliability: Style-owned assets, transactional job enqueue/commit,
-- and non-retrying lease expiry semantics.

alter table public.assets alter column project_id drop not null;
alter table public.assets add column style_id uuid references public.styles(id) on delete cascade;
alter table public.assets add constraint assets_exactly_one_owner_check
  check ((project_id is not null) <> (style_id is not null));
create index assets_style_id_idx on public.assets(style_id);

drop policy if exists "Users can manage assets in their workspace" on public.assets;
create policy "Users can manage assets in their workspace" on public.assets for all to authenticated
using (
  exists (select 1 from public.projects p where p.id = project_id and p.workspace_id in (select public.current_workspace_ids()))
  or exists (select 1 from public.styles s where s.id = style_id and s.workspace_id in (select public.current_workspace_ids()))
)
with check (
  exists (select 1 from public.projects p where p.id = project_id and p.workspace_id in (select public.current_workspace_ids()))
  or exists (select 1 from public.styles s where s.id = style_id and s.workspace_id in (select public.current_workspace_ids()))
);

drop policy if exists "Users can manage asset versions in their workspace" on public.asset_versions;
create policy "Users can manage asset versions in their workspace" on public.asset_versions for all to authenticated
using (exists (
  select 1 from public.assets a
  where a.id = asset_id and (
    exists (select 1 from public.projects p where p.id = a.project_id and p.workspace_id in (select public.current_workspace_ids()))
    or exists (select 1 from public.styles s where s.id = a.style_id and s.workspace_id in (select public.current_workspace_ids()))
  )
))
with check (exists (
  select 1 from public.assets a
  where a.id = asset_id and (
    exists (select 1 from public.projects p where p.id = a.project_id and p.workspace_id in (select public.current_workspace_ids()))
    or exists (select 1 from public.styles s where s.id = a.style_id and s.workspace_id in (select public.current_workspace_ids()))
  )
));

-- The old wide enqueue API is intentionally removed; callers use one of the two
-- narrow APIs below, so a mask cannot be supplied independently of its claim.
drop function if exists public.enqueue_ai_job(uuid, uuid, uuid, text, text, text, text, integer, text, text, uuid, uuid, text, uuid, text, text, text);
drop function if exists public.enqueue_ai_job(uuid, uuid, uuid, text, text, text, text, integer, text, text, uuid, uuid, text, uuid, text, text);
drop function if exists public.enqueue_ai_job(uuid, uuid, uuid, text, text, text, text, integer, text, text, uuid, uuid, text);

create function public.enqueue_text_to_image_job(
  p_workspace_id uuid, p_project_id uuid, p_requested_by uuid,
  p_provider text, p_model text, p_prompt text, p_count integer, p_size text,
  p_quality text, p_style_id uuid default null, p_original_prompt text default null,
  p_module text default 'projects', p_cost_mode text default null
) returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare v_job public.ai_jobs;
begin
  if auth.role() <> 'authenticated' or auth.uid() <> p_requested_by
     or p_workspace_id not in (select public.current_workspace_ids()) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_module not in ('projects','style') or char_length(btrim(coalesce(p_prompt,''))) not between 1 and 8000
     or p_provider not in ('openai','google') or p_quality not in ('low','medium','high','auto')
     or p_count not between 1 and 4 or p_size not in ('1024x1024','1536x1024','1024x1536','auto') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if p_cost_mode is not null and p_cost_mode not in ('strict_style','strict_1000','balanced','quality') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if (p_provider = 'openai' and p_model <> 'openai/gpt-image-2')
     or (p_provider = 'google' and (p_model !~ '^google/[a-z0-9._-]+$' or p_size = 'auto' or p_quality <> 'auto')) then
    raise exception 'INVALID_MODEL' using errcode = '22023';
  end if;
  if p_module = 'projects' then
    if p_project_id is null or not exists (select 1 from public.projects where id=p_project_id and workspace_id=p_workspace_id) then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
    if p_style_id is not null then raise exception 'INVALID_REQUEST' using errcode = '22023'; end if;
  else
    if p_project_id is not null or not exists (select 1 from public.styles where id=p_style_id and workspace_id=p_workspace_id and status='active') then
      raise exception 'STYLE_NOT_ACTIVE' using errcode = 'P0002';
    end if;
  end if;
  insert into public.ai_jobs(workspace_id,project_id,module,requested_by,operation,provider,model,status,input)
  values (p_workspace_id,p_project_id,p_module,p_requested_by,'text_to_image',p_provider,p_model,'queued',
    jsonb_build_object('prompt',btrim(p_prompt),'count',p_count,'size',p_size,'quality',p_quality,'style_id',p_style_id,'original_prompt',p_original_prompt)
      || case when p_cost_mode is null then '{}'::jsonb else jsonb_build_object('cost_mode',p_cost_mode) end)
  returning * into v_job;
  return v_job;
end; $$;

create function public.enqueue_inpaint_job(
  p_mask_id uuid, p_requested_by uuid, p_provider text, p_model text,
  p_prompt text, p_quality text
) returns public.ai_jobs language plpgsql security definer set search_path = public as $$
declare v_mask public.ai_job_inputs; v_job public.ai_jobs; v_asset_project uuid;
begin
  if auth.role() <> 'authenticated' or auth.uid() <> p_requested_by then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  select * into v_mask from public.ai_job_inputs where id=p_mask_id and job_id is null and expires_at>now() for update;
  if v_mask.id is null or v_mask.workspace_id not in (select public.current_workspace_ids()) then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if v_mask.project_id is null or not exists (select 1 from public.projects where id=v_mask.project_id and workspace_id=v_mask.workspace_id) then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  select a.project_id into v_asset_project from public.assets a where a.id=v_mask.asset_id;
  if v_asset_project is null or v_asset_project<>v_mask.project_id then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if p_provider<>'openai' or p_model<>'openai/gpt-image-2' then raise exception 'INVALID_MODEL' using errcode='22023'; end if;
  if char_length(btrim(coalesce(p_prompt,''))) not between 1 and 8000 or p_quality not in ('low','medium','high','auto') then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  if not exists (select 1 from public.asset_versions where id=v_mask.parent_version_id and asset_id=v_mask.asset_id) then raise exception 'VERSION_CONFLICT' using errcode='23000'; end if;
  insert into public.ai_jobs(workspace_id,project_id,module,requested_by,asset_id,parent_version_id,operation,provider,model,status,input)
  values (v_mask.workspace_id,v_mask.project_id,'projects',p_requested_by,v_mask.asset_id,v_mask.parent_version_id,'inpaint',p_provider,p_model,'queued',
    jsonb_build_object('prompt',btrim(p_prompt),'count',1,'size','auto','quality',p_quality,'mask_id',p_mask_id,'mask_storage_path',v_mask.storage_path)) returning * into v_job;
  update public.ai_job_inputs set job_id=v_job.id where id=p_mask_id;
  return v_job;
end; $$;

revoke all on function public.enqueue_text_to_image_job(uuid,uuid,uuid,text,text,text,integer,text,text,uuid,text,text,text) from public,anon;
grant execute on function public.enqueue_text_to_image_job(uuid,uuid,uuid,text,text,text,integer,text,text,uuid,text,text,text) to authenticated;
revoke all on function public.enqueue_inpaint_job(uuid,uuid,text,text,text,text) from public,anon;
grant execute on function public.enqueue_inpaint_job(uuid,uuid,text,text,text,text) to authenticated;

create or replace function public.claim_ai_jobs(p_worker_id text, p_limit integer, p_lease_seconds integer)
returns setof public.ai_jobs language plpgsql security definer set search_path=public as $$
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode='42501'; end if;
  if char_length(btrim(coalesce(p_worker_id,'')))=0 or p_limit not between 1 and 10 or p_lease_seconds not between 30 and 600 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  return query with claimed as (select id from public.ai_jobs where status='queued' and completed_at is null and attempt_count=0 order by created_at,id for update skip locked limit p_limit)
  update public.ai_jobs j set status='submitting',lease_owner=p_worker_id,lease_expires_at=now()+make_interval(secs=>p_lease_seconds),attempt_count=1,updated_at=now() from claimed where j.id=claimed.id returning j.*;
end; $$;

create function public.expire_stale_ai_jobs(p_limit integer default 20) returns setof public.ai_jobs
language plpgsql security definer set search_path=public as $$
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode='42501'; end if;
  return query with stale as (select id from public.ai_jobs where status in ('submitting','processing','persisting') and completed_at is null and lease_expires_at<now() order by lease_expires_at,id for update skip locked limit p_limit)
  update public.ai_jobs j set status='failed',error_code='PROVIDER_OUTCOME_UNKNOWN',error_message='Worker lease expired after provider processing began; automatic retry is disabled to avoid duplicate provider charges',lease_owner=null,lease_expires_at=null,completed_at=now(),updated_at=now() from stale where j.id=stale.id returning j.*;
end; $$;

create or replace function public.cancel_ai_job(p_job_id uuid) returns public.ai_jobs language plpgsql security definer set search_path=public as $$
declare v_job public.ai_jobs;
begin
  if auth.role()<>'authenticated' then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  select * into v_job from public.ai_jobs where id=p_job_id and workspace_id in (select public.current_workspace_ids()) for update;
  if v_job.id is null then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if v_job.status<>'queued' then raise exception 'JOB_NOT_CANCELABLE' using errcode='P0001'; end if;
  update public.ai_jobs set status='canceled',completed_at=now(),updated_at=now() where id=p_job_id returning * into v_job; return v_job;
end; $$;

revoke all on function public.claim_ai_jobs(text,integer,integer),public.expire_stale_ai_jobs(integer) from public,anon,authenticated;
grant execute on function public.claim_ai_jobs(text,integer,integer),public.expire_stale_ai_jobs(integer) to service_role;
revoke all on function public.cancel_ai_job(uuid) from public,anon;
grant execute on function public.cancel_ai_job(uuid) to authenticated;

create function public.complete_ai_job_with_results(
  p_job_id uuid, p_worker_id text, p_provider_request_id text, p_provider_status text,
  p_results jsonb, p_output jsonb
) returns public.ai_jobs language plpgsql security definer set search_path=public as $$
declare v_job public.ai_jobs; r jsonb; v_asset uuid; v_ver uuid; v_n integer:=0; v_expected integer; v_style uuid; v_project uuid; v_parent uuid; v_kind text;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode='42501'; end if;
  v_job:=public.assert_ai_job_lease(p_job_id,p_worker_id);
  if v_job.status<>'persisting' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  if jsonb_typeof(p_results)<>'array' then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  v_expected:=case when v_job.operation='inpaint' then 1 else coalesce((v_job.input->>'count')::integer,0) end;
  if jsonb_array_length(p_results)<>v_expected or v_expected<1 then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
  for r in select value from jsonb_array_elements(p_results) loop
    if jsonb_typeof(r)<>'object' or (select count(*) from jsonb_object_keys(r))<>11 or not (r ?& array['asset_id','version_id','storage_path','mime_type','width','height','byte_size','name','prompt','provider_response_id','metadata']) then raise exception 'INVALID_REQUEST' using errcode='22023'; end if;
    if r->>'mime_type' not in ('image/png','image/jpeg','image/webp') or (r->>'width')::integer<=0 or (r->>'height')::integer<=0 or (r->>'byte_size')::bigint<=0 or (r->>'byte_size')::bigint>52428800 or jsonb_typeof(r->'metadata')<>'object' then raise exception 'UNSUPPORTED_IMAGE' using errcode='22023'; end if;
    v_asset:=(r->>'asset_id')::uuid; v_ver:=(r->>'version_id')::uuid;
    if v_job.operation='inpaint' then
      if v_n>0 or v_asset<>v_job.asset_id or not exists(select 1 from public.asset_versions where id=v_job.parent_version_id and asset_id=v_asset) then raise exception 'VERSION_CONFLICT' using errcode='23000'; end if;
      insert into public.asset_versions(id,asset_id,parent_version_id,source,storage_path,mime_type,width,height,byte_size,prompt,provider_response_id,metadata) values(v_ver,v_asset,v_job.parent_version_id,'web_openai',r->>'storage_path',r->>'mime_type',(r->>'width')::integer,(r->>'height')::integer,(r->>'byte_size')::integer,r->>'prompt',r->>'provider_response_id',r->'metadata');
      update public.assets set current_version_id=v_ver,name=coalesce(nullif(btrim(r->>'name'),''),name),updated_at=now() where id=v_asset;
    else
      v_project:=v_job.project_id; v_style:=(v_job.input->>'style_id')::uuid;
      if v_job.module='style' then if v_style is null or not exists(select 1 from public.styles where id=v_style and workspace_id=v_job.workspace_id and status='active') then raise exception 'STYLE_NOT_ACTIVE' using errcode='P0002'; end if; v_kind:='generated'; insert into public.assets(id,project_id,style_id,name,kind) values(v_asset,null,v_style,coalesce(nullif(btrim(r->>'name'),''),'Untitled'),v_kind);
      else if v_project is null or not exists(select 1 from public.projects where id=v_project and workspace_id=v_job.workspace_id) then raise exception 'NOT_FOUND' using errcode='P0002'; end if; insert into public.assets(id,project_id,name,kind) values(v_asset,v_project,coalesce(nullif(btrim(r->>'name'),''),'Untitled'),'generated'); end if;
      insert into public.asset_versions(id,asset_id,source,storage_path,mime_type,width,height,byte_size,prompt,provider_response_id,metadata) values(v_ver,v_asset,'web_openai',r->>'storage_path',r->>'mime_type',(r->>'width')::integer,(r->>'height')::integer,(r->>'byte_size')::integer,r->>'prompt',r->>'provider_response_id',r->'metadata');
      update public.assets set current_version_id=v_ver,updated_at=now() where id=v_asset;
    end if;
    v_n:=v_n+1;
  end loop;
  update public.ai_jobs set status='succeeded',asset_id=(p_results->0->>'asset_id')::uuid,version_id=(p_results->0->>'version_id')::uuid,provider_request_id=p_provider_request_id,provider_status=p_provider_status,output=coalesce(p_output,'{}'::jsonb)||jsonb_build_object('results',coalesce((select jsonb_agg(jsonb_build_object('asset_id',x->>'asset_id','version_id',x->>'version_id','storage_path',x->>'storage_path')) from jsonb_array_elements(p_results) x),'[]'::jsonb)),lease_owner=null,lease_expires_at=null,error_code=null,error_message=null,completed_at=now(),updated_at=now() where id=p_job_id returning * into v_job;
  return v_job;
end; $$;

revoke all on function public.complete_ai_job_with_results(uuid,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.complete_ai_job_with_results(uuid,text,text,text,jsonb,jsonb) to service_role;

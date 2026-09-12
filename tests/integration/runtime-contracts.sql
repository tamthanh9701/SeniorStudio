-- pgTAP contracts executed inside a transaction by runtime-contracts.test.ts
select plan(4);
select has_table('public', 'ai_jobs', 'ai_jobs table exists');
select has_table('public', 'ai_quota_reservations', 'quota reservations table exists');
select has_function('public', 'complete_ai_job_with_results', array['uuid','text','text','text','jsonb','jsonb'], 'completion RPC exists');
select has_function('public', 'resolve_ai_job_persistence', array['uuid','text','uuid[]'], 'persistence resolver exists');
select * from finish();

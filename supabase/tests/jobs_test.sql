-- Job queue and capture tests.
\set ON_ERROR_STOP on

do $$
declare
  j1 public.jobs;
  j2 public.jobs;
  none public.jobs;
begin
  insert into public.jobs (kind, payload) values ('appraise_capture', '{"n":1}'), ('appraise_capture', '{"n":2}'), ('other', '{}');

  select * into j1 from public.claim_job(array['appraise_capture']);
  if j1.payload ->> 'n' <> '1' or j1.status <> 'running' or j1.attempts <> 1 then
    raise exception 'claim_job did not claim the oldest job: %', row_to_json(j1);
  end if;
  select * into j2 from public.claim_job(array['appraise_capture']);
  if j2.payload ->> 'n' <> '2' then raise exception 'second claim got the wrong job'; end if;
  select * into none from public.claim_job(array['appraise_capture']);
  if none.id is not null then raise exception 'claimed a job that was already running'; end if;

  -- Failure retries with backoff, then fails for good after max_attempts.
  perform public.finish_job(j1.id, 'boom');
  if (select status from public.jobs where id = j1.id) <> 'queued' then raise exception 'failed job was not requeued'; end if;
  if (select run_after from public.jobs where id = j1.id) <= now() then raise exception 'no backoff applied'; end if;
  update public.jobs set attempts = max_attempts where id = j1.id;
  perform public.finish_job(j1.id, 'boom again');
  if (select status from public.jobs where id = j1.id) <> 'failed' then raise exception 'job did not fail after max attempts'; end if;

  perform public.finish_job(j2.id);
  if (select status from public.jobs where id = j2.id) <> 'done' then raise exception 'job not marked done'; end if;

  -- A stale running job is reclaimed.
  update public.jobs set status = 'running', locked_at = now() - interval '1 hour' where kind = 'other';
  select * into none from public.claim_job(array['other']);
  if none.id is null then raise exception 'stale job was not reclaimed'; end if;

  if not exists (select 1 from storage.buckets where id = 'item-media' and public = false) then
    raise exception 'item-media bucket missing or public';
  end if;
end $$;

-- Clients cannot touch the queue.
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$
begin
  perform public.claim_job(array['appraise_capture']);
  raise exception 'authenticated role could claim jobs';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  if exists (select 1 from public.jobs) then raise exception 'RLS leak: jobs visible to clients'; end if;
end $$;
rollback;

-- Captures are private to their owner.
do $$
begin
  insert into public.captures (id, user_id) values ('40000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001');
end $$;
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000003';
do $$
begin
  if exists (select 1 from public.captures) then raise exception 'RLS leak: captures visible to another user'; end if;
end $$;
rollback;

select 'job tests passed' as result;

-- submit_capture records media, flips status and enqueues exactly 1 job; a second submit fails.
do $$
declare
  c public.captures;
  before_jobs int := (select count(*) from public.jobs where kind = 'appraise_capture');
begin
  insert into public.captures (id, user_id) values ('40000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001');
  c := public.submit_capture('00000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002',
    '[{"path": "a/b/0.jpg", "width": 1000, "height": 800, "sharpness": 12.5}, {"path": "a/b/1.jpg"}]'::jsonb);
  if c.status <> 'processing' or c.media_count <> 2 then raise exception 'submit_capture did not update capture: %', row_to_json(c); end if;
  if (select count(*) from public.capture_media where capture_id = c.id) <> 2 then raise exception 'media not recorded'; end if;
  if (select count(*) from public.jobs where kind = 'appraise_capture') <> before_jobs + 1 then raise exception 'job not enqueued'; end if;

  begin
    perform public.submit_capture('00000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', '[{"path": "x"}]'::jsonb);
    raise exception 'double submit allowed';
  exception when no_data_found then null;
  end;

  -- Another user's capture is invisible.
  if public.submit_capture('00000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', '[]'::jsonb) is not null then
    raise exception 'submitted another user''s capture';
  end if;
end $$;

select 'capture tests passed' as result;

-- The Prospector's timed triggers (Milestone 3): the 6-hour sweep and the weekly drop.
-- Runs inside a transaction that is rolled back, so later test files see the seed as is.
\set ON_ERROR_STOP on

begin;

insert into public.asks (id, user_id, raw_text, status) values
  ('30000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001', 'fresh', 'prospecting'),
  ('30000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000002', 'stale', 'prospecting'),
  ('30000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-000000000002', 'never run', 'prospecting'),
  ('30000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-000000000001', 'not looking', 'offering');
insert into public.ask_prospect_runs (ask_id, prospected_at) values
  ('30000000-0000-4000-8000-0000000000c1', now() - interval '1 hour'),
  ('30000000-0000-4000-8000-0000000000c2', now() - interval '7 hours'),
  ('30000000-0000-4000-8000-0000000000c4', now() - interval '7 days');

-- 1. The sweep queues prospecting Asks not run for 6 hours, once.
do $$
declare
  n int;
begin
  delete from public.jobs where kind = 'prospect_ask';
  n := public.enqueue_stale_prospects();
  if n <> 2 then raise exception 'expected 2 queued (stale and never run), got %', n; end if;
  if (select array_agg(payload ->> 'ask_id' order by payload ->> 'ask_id') from public.jobs where kind = 'prospect_ask')
     <> array['30000000-0000-4000-8000-0000000000c2', '30000000-0000-4000-8000-0000000000c3'] then
    raise exception 'wrong Asks queued';
  end if;
  if public.enqueue_stale_prospects() <> 0 then raise exception 'a second sweep queued duplicates'; end if;
end $$;

-- 2. The drop is due only on Sunday from 9am Pacific, once a week per active Circle.
do $$
declare
  circle constant uuid := '10000000-0000-4000-8000-000000000001';
  saturday constant timestamptz := '2026-10-10 12:00:00 America/Los_Angeles';
  sunday_early constant timestamptz := '2026-10-11 08:30:00 America/Los_Angeles';
  sunday constant timestamptz := '2026-10-11 09:05:00 America/Los_Angeles';
  next_sunday constant timestamptz := '2026-10-18 09:05:00 America/Los_Angeles';
begin
  delete from public.jobs where kind = 'drop_circle';
  if public.enqueue_due_drops(saturday) <> 0 or public.enqueue_due_drops(sunday_early) <> 0 then
    raise exception 'queued a drop outside Sunday morning';
  end if;
  if public.enqueue_due_drops(sunday) <> 1 then raise exception 'the Sunday drop was not queued'; end if;
  if (select payload ->> 'circle_id' from public.jobs where kind = 'drop_circle') <> circle::text then
    raise exception 'wrong drop payload';
  end if;
  if (select last_drop_at from public.circles where id = circle) <> sunday then raise exception 'not marked'; end if;
  if public.enqueue_due_drops(sunday + interval '2 hours') <> 0 then raise exception 'dropped twice in 1 morning'; end if;
  if public.enqueue_due_drops(next_sunday) <> 1 then raise exception 'next week''s drop was not queued'; end if;

  update public.circles set status = 'paused' where id = circle;
  if public.enqueue_due_drops(next_sunday + interval '7 days') <> 0 then raise exception 'a paused Circle dropped'; end if;
end $$;

-- 3. Server only.
do $$
begin
  if has_function_privilege('authenticated', 'public.enqueue_stale_prospects(interval)', 'execute')
     or has_function_privilege('authenticated', 'public.enqueue_due_drops(timestamptz, text)', 'execute') then
    raise exception 'schedule functions must be service role only';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.ask_prospect_runs'::regclass) then
    raise exception 'ask_prospect_runs needs RLS';
  end if;
end $$;

select 'prospect schedule tests passed';
rollback;

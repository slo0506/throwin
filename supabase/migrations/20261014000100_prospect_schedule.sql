-- Milestone 3: the Prospector's timed triggers (PRD agent roster: "New Ask, Shelf change in
-- the Circle, or every 6 hours"; matching modes: "Drop: once a week per Circle, Sunday
-- morning"). The worker calls both functions on a timer; they only queue jobs.

-- When each Ask was last prospected as the asker. Server only: no policies.
create table public.ask_prospect_runs (
  ask_id uuid primary key references public.asks (id) on delete cascade,
  prospected_at timestamptz not null default now()
);
alter table public.ask_prospect_runs enable row level security;

-- When each Circle last had its weekly drop.
alter table public.circles add column last_drop_at timestamptz;

-- Queues a prospect_ask for every prospecting Ask not prospected for p_older_than, so Asks
-- keep looking as Circles change around them. Returns how many were queued (Asks with a job
-- already waiting are skipped by enqueue_prospect_ask).
create or replace function public.enqueue_stale_prospects(p_older_than interval default interval '6 hours')
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ask record;
  v_count int := 0;
begin
  for v_ask in
    select a.id, a.user_id
      from public.asks a
      left join public.ask_prospect_runs r on r.ask_id = a.id
     where a.status = 'prospecting'
       and (r.prospected_at is null or r.prospected_at < now() - p_older_than)
  loop
    if public.enqueue_prospect_ask(v_ask.id, v_ask.user_id) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

-- Queues a drop_circle job for every active Circle whose weekly drop is due: it's Sunday,
-- 9am or later, in p_tz, and the last drop was over 6 days ago. Marks them as dropped so a
-- second call the same morning queues nothing. Returns how many were queued.
-- The pilot is in California, so the default is Pacific time; Circles have no time zone yet.
create or replace function public.enqueue_due_drops(
  p_now timestamptz default now(),
  p_tz text default 'America/Los_Angeles'
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_local timestamp := p_now at time zone p_tz;
  v_count int;
begin
  if extract(isodow from v_local) <> 7 or extract(hour from v_local) < 9 then
    return 0;
  end if;
  with due as (
    update public.circles
       set last_drop_at = p_now
     where status = 'active'
       and (last_drop_at is null or last_drop_at < p_now - interval '6 days')
    returning id
  )
  insert into public.jobs (kind, payload)
  select 'drop_circle', jsonb_build_object('circle_id', id) from due;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.enqueue_stale_prospects(interval) from public, anon, authenticated;
revoke execute on function public.enqueue_due_drops(timestamptz, text) from public, anon, authenticated;

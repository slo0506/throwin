-- Inquiries: the Liaison's question when a Loop rests on a guess.
-- Runs inside a transaction that is rolled back, so later test files see the seed as is.
-- From seed.sql: Jordan ...0001 (Batmobile ...0001, Zelda ...0002) and Maya ...0002
-- (Galaxy Explorer ...0003, Mario Wonder ...0004).
\set ON_ERROR_STOP on

begin;

-- Maya wants a Switch game like Zelda; Jordan's Batmobile is a guess for her LEGO Ask.
insert into public.asks (id, user_id, raw_text, status) values
  ('30000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000002', 'a LEGO car', 'prospecting'),
  ('30000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-000000000002', 'a Switch game', 'prospecting'),
  ('30000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-000000000002', 'done looking', 'offering');

-- 1. Opening: only for a prospecting Ask and the giver's own Item, once, within the limits.
do $$
declare
  jordan constant uuid := '00000000-0000-4000-8000-000000000001';
  maya constant uuid := '00000000-0000-4000-8000-000000000002';
  lego constant uuid := '30000000-0000-4000-8000-0000000000e1';
  r jsonb;
begin
  r := public.create_inquiry('30000000-0000-4000-8000-0000000000e3', '20000000-0000-4000-8000-000000000001', jordan);
  if r->>'result' <> 'invalid' then raise exception 'not prospecting: %', r; end if;
  r := public.create_inquiry(lego, '20000000-0000-4000-8000-000000000003', jordan);
  if r->>'result' <> 'invalid' then raise exception 'not the giver''s Item: %', r; end if;
  r := public.create_inquiry(lego, '20000000-0000-4000-8000-000000000001', jordan);
  if r->>'result' <> 'ok' then raise exception 'open: %', r; end if;
  if not exists (select 1 from public.jobs where kind = 'answer_inquiry' and payload->>'inquiry_id' = r->>'inquiry_id'
                   and payload->>'user_id' = maya::text) then
    raise exception 'the Liaison should be queued';
  end if;
  r := public.create_inquiry(lego, '20000000-0000-4000-8000-000000000001', jordan);
  if r->>'result' <> 'exists' then raise exception 'asked twice: %', r; end if;
  -- 1 question per Ask a day.
  r := public.create_inquiry(lego, '20000000-0000-4000-8000-000000000002', jordan);
  if r->>'result' <> 'limited' then raise exception 'a second question today: %', r; end if;
end $$;

-- 2. Yes re-matches the Ask; no keeps the Item away from it; answers are the asked person's.
do $$
declare
  jordan constant uuid := '00000000-0000-4000-8000-000000000001';
  maya constant uuid := '00000000-0000-4000-8000-000000000002';
  first uuid := (select id from public.inquiries where ask_id = '30000000-0000-4000-8000-0000000000e1');
  second uuid;
  r jsonb;
begin
  r := public.answer_inquiry(jordan, first, true);
  if r->>'result' <> 'not_found' then raise exception 'not Jordan''s to answer: %', r; end if;
  delete from public.jobs where kind = 'prospect_ask';
  r := public.answer_inquiry(maya, first, true, 'gm', '  You said any LEGO vehicle works.  ');
  if r->>'result' <> 'ok' then raise exception 'yes: %', r; end if;
  if (select status from public.inquiries where id = first) <> 'yes'
     or (select answered_by from public.inquiries where id = first) <> 'gm'
     or (select reason from public.inquiries where id = first) <> 'You said any LEGO vehicle works.' then
    raise exception 'answer not recorded';
  end if;
  if not exists (select 1 from public.jobs where kind = 'prospect_ask' and payload->>'ask_id' = '30000000-0000-4000-8000-0000000000e1') then
    raise exception 'yes should re-match the Ask';
  end if;
  r := public.answer_inquiry(maya, first, false);
  if r->>'result' <> 'closed' then raise exception 'answered twice: %', r; end if;

  r := public.create_inquiry('30000000-0000-4000-8000-0000000000e2', '20000000-0000-4000-8000-000000000001', jordan);
  second := (r->>'inquiry_id')::uuid;
  r := public.answer_inquiry(maya, second, false);
  if not exists (select 1 from public.ask_exclusions
                  where ask_id = '30000000-0000-4000-8000-0000000000e2' and item_id = '20000000-0000-4000-8000-000000000001') then
    raise exception 'no should keep the Item away from the Ask';
  end if;
end $$;

-- 3. 5 a day per person asked, and questions nobody answers expire.
do $$
declare
  jordan constant uuid := '00000000-0000-4000-8000-000000000001';
  maya constant uuid := '00000000-0000-4000-8000-000000000002';
  r jsonb;
  k int;
  ask uuid;
begin
  for k in 1..4 loop
    ask := gen_random_uuid();
    insert into public.asks (id, user_id, raw_text, status) values (ask, maya, 'more', 'prospecting');
    r := public.create_inquiry(ask, '20000000-0000-4000-8000-000000000002', jordan);
    if k <= 3 and r->>'result' <> 'ok' then raise exception 'question % should open: %', k, r; end if;
    if k = 4 and r->>'result' <> 'limited' then raise exception 'a 6th question today: %', r; end if;
  end loop;
  update public.inquiries set expires_at = now() - interval '1 minute' where status = 'pending';
  if public.expire_inquiries() <> 3 then raise exception 'expected 3 to expire'; end if;
end $$;

-- 4. Only the server opens, answers and expires questions.
do $$
begin
  if has_function_privilege('authenticated', 'public.create_inquiry(uuid, uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.answer_inquiry(uuid, uuid, boolean, text, text)', 'execute')
     or has_function_privilege('anon', 'public.expire_inquiries()', 'execute') then
    raise exception 'inquiry functions must be service role only';
  end if;
end $$;

select 'inquiry tests passed';
rollback;

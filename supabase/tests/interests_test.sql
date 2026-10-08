-- Interests: "someone wants your Item" for Items offered for nothing.
-- Runs inside a transaction that is rolled back, so later test files see the seed as is.
-- From seed.sql: Jordan ...0001 (Batmobile ...0001, Zelda ...0002) and Maya ...0002
-- (Galaxy Explorer ...0003, Mario Wonder ...0004), both in the Thursday Lego Circle.
\set ON_ERROR_STOP on

begin;

-- Maya wants a Switch game and offers her Galaxy Explorer for it. Jordan's Zelda is on his
-- Shelf, offered for nothing.
insert into public.asks (id, user_id, raw_text, status) values
  ('30000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-000000000002', 'a Switch game', 'prospecting'),
  ('30000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-000000000002', 'done looking', 'offering');
insert into public.offer_sets (ask_id, item_id) values
  ('30000000-0000-4000-8000-0000000000f1', '20000000-0000-4000-8000-000000000003');

-- 1. Telling the owner: only for a prospecting Ask and a Circle-mate's Item, once.
do $$
declare
  switch constant uuid := '30000000-0000-4000-8000-0000000000f1';
  zelda constant uuid := '20000000-0000-4000-8000-000000000002';
  r jsonb;
begin
  r := public.create_interest('30000000-0000-4000-8000-0000000000f2', zelda);
  if r->>'result' <> 'invalid' then raise exception 'not prospecting: %', r; end if;
  r := public.create_interest(switch, '20000000-0000-4000-8000-000000000004');
  if r->>'result' <> 'invalid' then raise exception 'Maya''s own Item: %', r; end if;
  r := public.create_interest(switch, zelda);
  if r->>'result' <> 'ok' then raise exception 'tell: %', r; end if;
  if (select owner_id from public.interests where id = (r->>'interest_id')::uuid)
     <> '00000000-0000-4000-8000-000000000001' then
    raise exception 'Jordan should be the one told';
  end if;
  r := public.create_interest(switch, zelda);
  if r->>'result' <> 'exists' then raise exception 'told twice: %', r; end if;
end $$;

-- 2. Yes with 1 of Maya's offered Items makes Jordan an Ask for it, offering his Zelda,
--    and queues matching. Only Jordan answers, once.
do $$
declare
  jordan constant uuid := '00000000-0000-4000-8000-000000000001';
  maya constant uuid := '00000000-0000-4000-8000-000000000002';
  first uuid := (select id from public.interests where ask_id = '30000000-0000-4000-8000-0000000000f1');
  r jsonb;
  made uuid;
begin
  r := public.answer_interest(maya, first, '20000000-0000-4000-8000-000000000003');
  if r->>'result' <> 'not_found' then raise exception 'not Maya''s to answer: %', r; end if;
  -- Mario Wonder isn't on offer for that Ask.
  r := public.answer_interest(jordan, first, '20000000-0000-4000-8000-000000000004');
  if r->>'result' <> 'invalid' then raise exception 'not on offer: %', r; end if;
  delete from public.jobs where kind = 'prospect_ask';
  r := public.answer_interest(jordan, first, '20000000-0000-4000-8000-000000000003');
  if r->>'result' <> 'ok' then raise exception 'yes: %', r; end if;
  made := (r->>'ask_id')::uuid;
  if not exists (select 1 from public.asks where id = made and user_id = jordan and status = 'prospecting'
                   and target->>'name' = 'Galaxy Explorer' and title = 'Galaxy Explorer') then
    raise exception 'yes should make Jordan an Ask for it';
  end if;
  if not exists (select 1 from public.offer_sets where ask_id = made and item_id = '20000000-0000-4000-8000-000000000002') then
    raise exception 'the Ask should offer his Zelda';
  end if;
  if not exists (select 1 from public.jobs where kind = 'prospect_ask' and payload->>'ask_id' = made::text) then
    raise exception 'yes should start matching';
  end if;
  if (select status from public.interests where id = first) <> 'accepted'
     or (select answer_ask_id from public.interests where id = first) <> made then
    raise exception 'answer not recorded';
  end if;
  r := public.answer_interest(jordan, first, null);
  if r->>'result' <> 'closed' then raise exception 'answered twice: %', r; end if;
end $$;

-- 3. No keeps the Item away from that Ask; the limits hold; unanswered ones expire.
do $$
declare
  jordan constant uuid := '00000000-0000-4000-8000-000000000001';
  maya constant uuid := '00000000-0000-4000-8000-000000000002';
  batmobile constant uuid := '20000000-0000-4000-8000-000000000001';
  ask uuid;
  r jsonb;
  k int;
begin
  ask := gen_random_uuid();
  insert into public.asks (id, user_id, raw_text, status) values (ask, maya, 'a LEGO car', 'prospecting');
  r := public.create_interest(ask, batmobile);
  r := public.answer_interest(jordan, (r->>'interest_id')::uuid, null);
  if r->>'result' <> 'ok' or not exists (select 1 from public.ask_exclusions where ask_id = ask and item_id = batmobile) then
    raise exception 'no should keep the Item away from the Ask: %', r;
  end if;
  -- Jordan has been told twice today; the 3rd opens, the 4th waits.
  for k in 1..2 loop
    ask := gen_random_uuid();
    insert into public.asks (id, user_id, raw_text, status) values (ask, maya, 'more', 'prospecting');
    r := public.create_interest(ask, batmobile);
    if k = 1 and r->>'result' <> 'ok' then raise exception 'the 3rd should open: %', r; end if;
    if k = 2 and r->>'result' <> 'limited' then raise exception 'a 4th today: %', r; end if;
  end loop;
  update public.interests set expires_at = now() - interval '1 minute' where status = 'pending';
  if public.expire_interests() <> 1 then raise exception 'expected 1 to expire'; end if;
end $$;

-- 4. Only the server reads candidates and opens, answers and expires interests.
do $$
begin
  if has_function_privilege('authenticated', 'public.shelf_interest_candidates(uuid, text, int)', 'execute')
     or has_function_privilege('authenticated', 'public.create_interest(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.answer_interest(uuid, uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.expire_interests()', 'execute') then
    raise exception 'interest functions must be service role only';
  end if;
end $$;

select 'interest tests passed';
rollback;

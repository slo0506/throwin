-- Counters: propose, answer, withdraw and expire, and the new version of a Deal.
-- Runs inside a transaction that is rolled back, so later test files see the seed as is.
-- From seed.sql: Jordan ...0001 (Batmobile ...0001, Zelda ...0002) and Maya ...0002
-- (Galaxy Explorer ...0003, Mario Wonder ...0004) share the Thursday Lego Circle.
\set ON_ERROR_STOP on

begin;

update public.items set photo_score = 80, missing_angles = '{}'
 where id in ('20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003',
              '20000000-0000-4000-8000-000000000004');

insert into public.asks (id, user_id, raw_text, status, cash_ceiling_cents) values
  ('30000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001', 'Galaxy Explorer', 'prospecting', 5000),
  ('30000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000002', 'Zelda', 'prospecting', 0);
insert into public.offer_sets (ask_id, item_id) values
  ('30000000-0000-4000-8000-0000000000c1', '20000000-0000-4000-8000-000000000002'),
  ('30000000-0000-4000-8000-0000000000c2', '20000000-0000-4000-8000-000000000003');

-- Galaxy Explorer for Zelda plus $20: the Deal everyone sees first.
create function pg_temp.legs(p_extra text default null) returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('giver', '00000000-0000-4000-8000-000000000002', 'receiver', '00000000-0000-4000-8000-000000000001',
                       'item_id', '20000000-0000-4000-8000-000000000003',
                       'ask_id', '30000000-0000-4000-8000-0000000000c1', 'giver_ask_id', '30000000-0000-4000-8000-0000000000c2'),
    jsonb_build_object('giver', '00000000-0000-4000-8000-000000000001', 'receiver', '00000000-0000-4000-8000-000000000002',
                       'item_id', '20000000-0000-4000-8000-000000000002',
                       'ask_id', '30000000-0000-4000-8000-0000000000c2', 'giver_ask_id', '30000000-0000-4000-8000-0000000000c1'))
  || case when p_extra is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
       'giver', '00000000-0000-4000-8000-000000000002', 'receiver', '00000000-0000-4000-8000-000000000001',
       'item_id', p_extra)) end;
$$;

-- Jordan's counter: Maya adds Mario Wonder, and Jordan's cash goes to $5.
create function pg_temp.add_mario() returns jsonb language sql as $$
  select jsonb_build_object(
    'item_legs', pg_temp.legs('20000000-0000-4000-8000-000000000004'),
    'cash_legs', jsonb_build_array(jsonb_build_object(
      'payer', '00000000-0000-4000-8000-000000000001', 'payee', '00000000-0000-4000-8000-000000000002', 'amount_cents', 500)),
    'fairness', '[]'::jsonb,
    'cash_moved_cents', 500);
$$;

create function pg_temp.propose(p_user text, p_deal uuid, p_proposal jsonb, p_awaiting text[]) returns jsonb
language sql as $$
  select public.propose_counter(p_user::uuid, p_deal,
    '[{"op": "add", "item_id": "20000000-0000-4000-8000-000000000004"}]'::jsonb, p_proposal, p_awaiting::uuid[]);
$$;

do $$
declare
  r jsonb;
begin
  r := public.stage_deal(jsonb_build_object(
    'item_legs', pg_temp.legs(),
    'cash_legs', jsonb_build_array(jsonb_build_object(
      'payer', '00000000-0000-4000-8000-000000000001', 'payee', '00000000-0000-4000-8000-000000000002', 'amount_cents', 2000)),
    'whys', jsonb_build_object('00000000-0000-4000-8000-000000000001', 'Galaxy Explorer, like you asked.')));
  if r->>'result' <> 'ok' then raise exception 'stage failed: %', r; end if;
end $$;

-- 1. Proposing: only participants, 1 open counter at a time, and approvals wait for it.
do $$
declare
  jordan constant text := '00000000-0000-4000-8000-000000000001';
  maya constant text := '00000000-0000-4000-8000-000000000002';
  deal uuid := (select id from public.deals);
  r jsonb;
begin
  r := pg_temp.propose('00000000-0000-4000-8000-000000000003', deal, pg_temp.add_mario(), array[maya]);
  if r->>'result' <> 'not_found' then raise exception 'outsider: %', r; end if;
  r := pg_temp.propose(jordan, deal, pg_temp.add_mario(), array[jordan]);
  if r->>'result' <> 'invalid' then raise exception 'asking yourself: %', r; end if;
  r := pg_temp.propose(jordan, deal, pg_temp.add_mario(), array[maya]);
  if r->>'result' <> 'ok' then raise exception 'propose: %', r; end if;
  if (select counter_rounds from public.deals where id = deal) <> 1 then raise exception 'round not counted'; end if;
  r := pg_temp.propose(maya, deal, pg_temp.add_mario(), array[jordan]);
  if r->>'result' <> 'counter_open' then raise exception 'second counter: %', r; end if;
  r := public.approve_deal(maya::uuid, deal, '{}');
  if r->>'result' <> 'counter_open' then raise exception 'approved over a counter: %', r; end if;
end $$;

-- 2. Declining leaves the Deal as it was, and approvals work again.
do $$
declare
  jordan constant uuid := '00000000-0000-4000-8000-000000000001';
  maya constant uuid := '00000000-0000-4000-8000-000000000002';
  deal uuid := (select id from public.deals);
  counter uuid := (select id from public.deal_counters);
  r jsonb;
begin
  r := public.respond_counter(jordan, counter, true);
  if r->>'result' <> 'not_found' then raise exception 'the proposer answered: %', r; end if;
  r := public.respond_counter(maya, counter, false);
  if r->>'result' <> 'ok' or r->>'status' <> 'declined' then raise exception 'decline: %', r; end if;
  r := public.respond_counter(maya, counter, true);
  if r->>'result' <> 'closed' then raise exception 'answered twice: %', r; end if;
  if (select status from public.deals where id = deal) <> 'pending_approvals'
     or (select reserved_by_deal_id from public.items where id = '20000000-0000-4000-8000-000000000004') is not null then
    raise exception 'a declined counter changed the Deal';
  end if;
  r := public.approve_deal(maya, deal, '{}');
  if r->>'result' <> 'ok' then raise exception 'approve after decline: %', r; end if;
end $$;

-- 3. Accepting makes the new version: Items moved and added, old Deal superseded, whys
--    carried over, everyone pending again, Asks still proposed.
do $$
declare
  jordan constant text := '00000000-0000-4000-8000-000000000001';
  maya constant uuid := '00000000-0000-4000-8000-000000000002';
  old uuid := (select id from public.deals);
  counter uuid;
  r jsonb;
  v_new uuid;
begin
  r := pg_temp.propose(jordan, old, pg_temp.add_mario(), array[maya::text]);
  counter := (r->>'counter_id')::uuid;
  r := public.respond_counter(maya, counter, true);
  if r->>'result' <> 'ok' or r->>'status' <> 'accepted' then raise exception 'accept: %', r; end if;
  v_new := (r->>'deal_id')::uuid;
  if (select status from public.deals where id = old) <> 'cancelled'
     or (select superseded_by from public.deals where id = old) <> v_new then
    raise exception 'the old Deal should point at the new one';
  end if;
  if (select status from public.deals where id = v_new) <> 'pending_approvals'
     or (select counter_rounds from public.deals where id = v_new) <> 2 then
    raise exception 'the new version should wait for approvals, with the rounds carried over';
  end if;
  if (select count(*) from public.items where reserved_by_deal_id = v_new) <> 3 then
    raise exception 'all 3 Items should be held by the new version';
  end if;
  if (select count(*) from public.deal_legs where deal_id = v_new and item_id is not null) <> 3
     or (select throw_in_cents from public.deal_legs where deal_id = v_new and item_id is null) <> 500 then
    raise exception 'legs are wrong';
  end if;
  if exists (select 1 from public.deal_participants where deal_id = v_new and approval <> 'pending')
     or (select why from public.deal_participants where deal_id = v_new and user_id = jordan::uuid)
        <> 'Galaxy Explorer, like you asked.' then
    raise exception 'everyone approves again, and whys carry over';
  end if;
  if exists (select 1 from public.asks where id in ('30000000-0000-4000-8000-0000000000c1', '30000000-0000-4000-8000-0000000000c2')
               and status <> 'proposed') then
    raise exception 'Asks should stay proposed';
  end if;
  if (select new_deal_id from public.deal_counters where id = counter) <> v_new then
    raise exception 'the counter should point at the new version';
  end if;
end $$;

-- 4. A counter that drops an Item releases it, and the 4th counter is refused.
do $$
declare
  jordan constant uuid := '00000000-0000-4000-8000-000000000001';
  maya constant text := '00000000-0000-4000-8000-000000000002';
  deal uuid := (select id from public.deals where status = 'pending_approvals');
  r jsonb;
begin
  r := pg_temp.propose(maya, deal, jsonb_build_object('item_legs', pg_temp.legs(), 'cash_legs', '[]'::jsonb), array[jordan::text]);
  if r->>'result' <> 'ok' then raise exception 'third counter: %', r; end if;
  r := public.respond_counter(jordan, (r->>'counter_id')::uuid, true);
  if r->>'result' <> 'ok' then raise exception 'accept the drop: %', r; end if;
  if (select status from public.items where id = '20000000-0000-4000-8000-000000000004') <> 'on_shelf' then
    raise exception 'Mario Wonder should be back on the Shelf';
  end if;
  r := pg_temp.propose(maya, (r->>'deal_id')::uuid, pg_temp.add_mario(), array[jordan::text]);
  if r->>'result' <> 'no_rounds_left' then raise exception 'a 4th counter: %', r; end if;
end $$;

-- 5. An added Item taken by another Deal first: the counter expires and the Deal goes on.
do $$
declare
  maya constant uuid := '00000000-0000-4000-8000-000000000002';
  deal uuid := (select id from public.deals where status = 'pending_approvals');
  counter uuid;
  r jsonb;
begin
  update public.deals set counter_rounds = 0 where id = deal;
  r := pg_temp.propose('00000000-0000-4000-8000-000000000001', deal, pg_temp.add_mario(), array[maya::text]);
  counter := (r->>'counter_id')::uuid;
  update public.items set status = 'removed' where id = '20000000-0000-4000-8000-000000000004';
  r := public.respond_counter(maya, counter, true);
  if r->>'result' <> 'items_taken' then raise exception 'taken Item: %', r; end if;
  if (select status from public.deal_counters where id = counter) <> 'expired'
     or (select status from public.deals where id = deal) <> 'pending_approvals'
     or (select count(*) from public.deals where superseded_by is null and status = 'pending_approvals') <> 1 then
    raise exception 'the Deal should go on unchanged';
  end if;
  update public.items set status = 'on_shelf' where id = '20000000-0000-4000-8000-000000000004';
end $$;

-- 6. Withdrawing, and expiry.
do $$
declare
  jordan constant uuid := '00000000-0000-4000-8000-000000000001';
  maya constant text := '00000000-0000-4000-8000-000000000002';
  deal uuid := (select id from public.deals where status = 'pending_approvals');
  counter uuid;
  r jsonb;
begin
  update public.deals set counter_rounds = 0 where id = deal;
  counter := (pg_temp.propose(jordan::text, deal, pg_temp.add_mario(), array[maya])->>'counter_id')::uuid;
  if public.withdraw_counter(maya::uuid, counter)->>'result' <> 'not_found' then raise exception 'not hers to withdraw'; end if;
  if public.withdraw_counter(jordan, counter)->>'result' <> 'ok' then raise exception 'withdraw failed'; end if;
  if public.withdraw_counter(jordan, counter)->>'result' <> 'closed' then raise exception 'withdrew twice'; end if;

  counter := (pg_temp.propose(jordan::text, deal, pg_temp.add_mario(), array[maya])->>'counter_id')::uuid;
  update public.deal_counters set expires_at = now() - interval '1 minute' where id = counter;
  perform public.expire_deals();
  if (select status from public.deal_counters where id = counter) <> 'expired'
     or (select status from public.deals where id = deal) <> 'pending_approvals' then
    raise exception 'an expired counter should leave the Deal open';
  end if;

  counter := (pg_temp.propose(jordan::text, deal, pg_temp.add_mario(), array[maya])->>'counter_id')::uuid;
  if not public.close_deal(deal, 'cancelled') then raise exception 'close failed'; end if;
  if (select status from public.deal_counters where id = counter) <> 'expired' then
    raise exception 'closing a Deal should expire its counter';
  end if;
end $$;

-- 7. Only the server proposes, answers and withdraws.
do $$
begin
  if has_function_privilege('authenticated', 'public.propose_counter(uuid, uuid, jsonb, jsonb, uuid[])', 'execute')
     or has_function_privilege('authenticated', 'public.respond_counter(uuid, uuid, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.withdraw_counter(uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.respond_counter(uuid, uuid, boolean)', 'execute') then
    raise exception 'counter functions must be service role only';
  end if;
end $$;

select 'deal counter tests passed';
rollback;

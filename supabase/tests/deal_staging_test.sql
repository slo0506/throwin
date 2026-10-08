-- Staging Deals, promotion to approval, and expiry (Milestone 3).
-- Runs inside a transaction that is rolled back, so later test files see the seed as is.
-- From seed.sql: Jordan ...0001 (Batmobile ...0001, Zelda ...0002) and Maya ...0002
-- (Galaxy Explorer ...0003, Mario Wonder ...0004) share the Thursday Lego Circle.
\set ON_ERROR_STOP on

begin;

-- Jordan wants Maya's Galaxy Explorer and offers Zelda (up to $50 cash). Maya wants Zelda
-- and offers Galaxy Explorer (no cash).
insert into public.asks (id, user_id, raw_text, status, cash_ceiling_cents) values
  ('30000000-0000-4000-8000-000000000091', '00000000-0000-4000-8000-000000000001', 'Galaxy Explorer', 'prospecting', 5000),
  ('30000000-0000-4000-8000-000000000092', '00000000-0000-4000-8000-000000000002', 'Zelda', 'prospecting', 0);
insert into public.offer_sets (ask_id, item_id) values
  ('30000000-0000-4000-8000-000000000091', '20000000-0000-4000-8000-000000000002'),
  ('30000000-0000-4000-8000-000000000092', '20000000-0000-4000-8000-000000000003');

create function pg_temp.deal(p_cash jsonb default null) returns jsonb language sql as $$
  select jsonb_build_object(
    'users', jsonb_build_array('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'),
    'item_legs', jsonb_build_array(
      jsonb_build_object('giver', '00000000-0000-4000-8000-000000000002', 'receiver', '00000000-0000-4000-8000-000000000001',
                         'item_id', '20000000-0000-4000-8000-000000000003', 'value_cents', 8500,
                         'ask_id', '30000000-0000-4000-8000-000000000091', 'giver_ask_id', '30000000-0000-4000-8000-000000000092', 'kind', 'explicit'),
      jsonb_build_object('giver', '00000000-0000-4000-8000-000000000001', 'receiver', '00000000-0000-4000-8000-000000000002',
                         'item_id', '20000000-0000-4000-8000-000000000002', 'value_cents', 4200,
                         'ask_id', '30000000-0000-4000-8000-000000000092', 'giver_ask_id', '30000000-0000-4000-8000-000000000091', 'kind', 'explicit')),
    'cash_legs', coalesce(p_cash, jsonb_build_array(
      jsonb_build_object('payer', '00000000-0000-4000-8000-000000000001', 'payee', '00000000-0000-4000-8000-000000000002', 'amount_cents', 3000))),
    'fairness', '[{"user": "00000000-0000-4000-8000-000000000001", "net_cents": 1300}]'::jsonb,
    'cash_moved_cents', 3000,
    'score', 1.2
  );
$$;

-- 1. Malformed or stale Deals are refused and write nothing.
do $$
declare
  jordan constant text := '00000000-0000-4000-8000-000000000001';
  maya constant text := '00000000-0000-4000-8000-000000000002';
  d jsonb := pg_temp.deal();
  r text;
begin
  r := public.stage_deal(jsonb_set(d, '{item_legs}', jsonb_build_array(d->'item_legs'->0)))->>'result';
  if r <> 'invalid' then raise exception '1 leg: %', r; end if;
  -- Jordan receives twice and Maya never does.
  r := public.stage_deal(jsonb_set(d, '{item_legs,1,receiver}', to_jsonb(jordan)))->>'result';
  if r <> 'invalid' then raise exception 'double receiver: %', r; end if;
  r := public.stage_deal(pg_temp.deal(jsonb_build_array(jsonb_build_object(
         'payer', jordan, 'payee', '00000000-0000-4000-8000-000000000003', 'amount_cents', 100))))->>'result';
  if r <> 'invalid' then raise exception 'cash to an outsider: %', r; end if;
  r := public.stage_deal(pg_temp.deal(jsonb_build_array(jsonb_build_object(
         'payer', jordan, 'payee', maya, 'amount_cents', 6000))))->>'result';
  if r <> 'over_ceiling' then raise exception 'over Jordan''s $50: %', r; end if;
  r := public.stage_deal(pg_temp.deal(jsonb_build_array(jsonb_build_object(
         'payer', maya, 'payee', jordan, 'amount_cents', 100))))->>'result';
  if r <> 'over_ceiling' then raise exception 'Maya has no cash ceiling: %', r; end if;

  update public.asks set status = 'offering' where id = '30000000-0000-4000-8000-000000000092';
  r := public.stage_deal(d)->>'result';
  if r <> 'ask_unavailable' then raise exception 'Maya''s Ask stopped prospecting: %', r; end if;
  update public.asks set status = 'prospecting' where id = '30000000-0000-4000-8000-000000000092';

  delete from public.offer_sets where ask_id = '30000000-0000-4000-8000-000000000092';
  r := public.stage_deal(d)->>'result';
  if r <> 'offer_changed' then raise exception 'Galaxy left the offer: %', r; end if;
  insert into public.offer_sets (ask_id, item_id)
  values ('30000000-0000-4000-8000-000000000092', '20000000-0000-4000-8000-000000000003');

  if exists (select 1 from public.deals) then raise exception 'a refused Deal was written'; end if;
end $$;

-- Neither Item is identified yet: the GM isn't sure what they are.
update public.items set identity_conf = 0.5
 where id in ('20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003');

-- 2. A valid Deal is staged: Items held, legs and participants written, Asks proposed.
do $$
declare
  r jsonb := public.stage_deal(pg_temp.deal(), 'live', null);
  deal uuid := (r->>'deal_id')::uuid;
begin
  if r->>'result' <> 'ok' then raise exception 'stage failed: %', r; end if;
  -- Neither Item is identified yet, so it waits up to 24 hours for its owners to pin them down.
  if (select status from public.deals where id = deal) <> 'staged' then raise exception 'should be staged'; end if;
  if (select expires_at from public.deals where id = deal) not between now() + interval '23 hours' and now() + interval '25 hours' then
    raise exception 'staged Deals should wait 24 hours';
  end if;
  if (select fairness->>'cash_moved_cents' from public.deals where id = deal) <> '3000' then
    raise exception 'fairness not stored';
  end if;
  if (select count(*) from public.items where reserved_by_deal_id = deal and status = 'reserved') <> 2 then
    raise exception 'both Items should be reserved';
  end if;
  if (select count(*) from public.deal_legs where deal_id = deal and item_id is not null and ask_id is not null) <> 2
     or not exists (select 1 from public.deal_legs where deal_id = deal and item_id is null and throw_in_cents = 3000
                      and giver_id = '00000000-0000-4000-8000-000000000001' and receiver_id = '00000000-0000-4000-8000-000000000002') then
    raise exception 'legs are wrong';
  end if;
  if (select count(*) from public.deal_participants where deal_id = deal and approval = 'pending') <> 2 then
    raise exception 'both people should be pending participants';
  end if;
  if exists (select 1 from public.asks where id in ('30000000-0000-4000-8000-000000000091', '30000000-0000-4000-8000-000000000092') and status <> 'proposed') then
    raise exception 'both Asks should be proposed';
  end if;
end $$;

-- 3. The same Items can't be promised twice: the whole second Deal rolls back.
do $$
declare
  r text;
begin
  update public.asks set status = 'prospecting'
   where id in ('30000000-0000-4000-8000-000000000091', '30000000-0000-4000-8000-000000000092');
  r := public.stage_deal(pg_temp.deal())->>'result';
  if r <> 'items_taken' then raise exception 'double booking: %', r; end if;
  if (select count(*) from public.deals) <> 1 or (select count(*) from public.deal_legs) <> 3 then
    raise exception 'the refused Deal left rows behind';
  end if;
  update public.asks set status = 'proposed'
   where id in ('30000000-0000-4000-8000-000000000091', '30000000-0000-4000-8000-000000000092');
end $$;

-- 4. When the last Item is identified, the Deal goes out for approval with 48 hours. It
--    doesn't wait for showcase photos (decided Oct 7, 2026).
do $$
declare
  deal uuid := (select id from public.deals);
begin
  update public.items set identity_conf = 0.9 where id = '20000000-0000-4000-8000-000000000003';
  if (select readiness from public.items where id = '20000000-0000-4000-8000-000000000003') = 'logged' then
    raise exception 'Galaxy should be identified now';
  end if;
  if (select status from public.deals where id = deal) <> 'staged' then
    raise exception 'promoted with 1 Item still only logged';
  end if;
  update public.items set identity_conf = 0.9 where id = '20000000-0000-4000-8000-000000000002';
  if (select readiness from public.items where id = '20000000-0000-4000-8000-000000000002') = 'showcase' then
    raise exception 'this case needs Zelda below showcase';
  end if;
  if (select status from public.deals where id = deal) <> 'pending_approvals' then
    raise exception 'should be pending approvals once every Item is identified';
  end if;
  if (select expires_at from public.deals where id = deal) < now() + interval '47 hours' then
    raise exception 'the approval clock should restart at 48 hours';
  end if;
end $$;

-- 5. Expiry cancels the Deal, frees the Items and sends both Asks back to prospecting,
--    which queues a re-match for each.
do $$
declare
  deal uuid := (select id from public.deals);
  n int;
begin
  update public.jobs set status = 'done' where kind = 'prospect_ask';
  update public.deals set expires_at = now() - interval '1 minute' where id = deal;
  n := public.expire_deals();
  if n <> 1 then raise exception 'expected 1 expired Deal, got %', n; end if;
  if (select status from public.deals where id = deal) <> 'cancelled' then raise exception 'not cancelled'; end if;
  if exists (select 1 from public.items where reserved_by_deal_id is not null or status = 'reserved') then
    raise exception 'Items still held';
  end if;
  if exists (select 1 from public.asks where id in ('30000000-0000-4000-8000-000000000091', '30000000-0000-4000-8000-000000000092') and status <> 'prospecting') then
    raise exception 'Asks should be prospecting again';
  end if;
  if (select count(*) from public.jobs where kind = 'prospect_ask' and status = 'queued') <> 2 then
    raise exception 'each Ask should be queued for a re-match';
  end if;
  -- Closing twice is a no-op, and a second sweep finds nothing.
  if public.close_deal(deal, 'cancelled') then raise exception 'closed a closed Deal'; end if;
  if public.expire_deals() <> 0 then raise exception 'expired twice'; end if;
end $$;

-- 6. A Deal whose Items are all identified skips straight to approval, and each person's
--    why from the review is stored on their own participant row.
do $$
declare
  r jsonb := public.stage_deal(pg_temp.deal() || jsonb_build_object('whys', jsonb_build_object(
    '00000000-0000-4000-8000-000000000001', '  You said you wanted a space set.  ',
    '00000000-0000-4000-8000-000000000002', '')));
  deal uuid := (r->>'deal_id')::uuid;
begin
  if r->>'result' <> 'ok' then raise exception 'restage failed: %', r; end if;
  if (select status from public.deals where id = deal) <> 'pending_approvals' then
    raise exception 'identified Items should skip staging';
  end if;
  if (select why from public.deal_participants where deal_id = deal and user_id = '00000000-0000-4000-8000-000000000001')
       <> 'You said you wanted a space set.'
     or (select why from public.deal_participants where deal_id = deal and user_id = '00000000-0000-4000-8000-000000000002') is not null then
    raise exception 'whys not stored per participant';
  end if;
end $$;

-- 7. Only the server stages, closes and expires Deals.
do $$
begin
  if has_function_privilege('authenticated', 'public.stage_deal(jsonb, public.deal_mode, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.close_deal(uuid, public.deal_status)', 'execute')
     or has_function_privilege('authenticated', 'public.expire_deals()', 'execute')
     or has_function_privilege('anon', 'public.stage_deal(jsonb, public.deal_mode, uuid)', 'execute') then
    raise exception 'Deal functions must be service role only';
  end if;
end $$;

select 'deal staging tests passed';
rollback;

-- Bundles: a Deal that hands a person several Items (X for Y).
-- Runs inside a transaction that is rolled back, so later test files see the seed as is.
-- From seed.sql: Jordan ...0001 (Batmobile ...0001, Zelda ...0002) and Maya ...0002
-- (Galaxy Explorer ...0003, Mario Wonder ...0004) share the Thursday Lego Circle.
\set ON_ERROR_STOP on

begin;

-- Jordan wants Galaxy Explorer and offers the Batmobile and Zelda for it ($10 ceiling).
-- Maya wants "2 LEGO or Switch things" (takes 2) and a Batmobile (takes 1), offering
-- Galaxy Explorer and Mario Wonder for the first.
insert into public.asks (id, user_id, raw_text, status, cash_ceiling_cents, max_items) values
  ('30000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000001', 'Galaxy Explorer', 'prospecting', 1000, 1),
  ('30000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-000000000002', 'LEGO or Switch', 'prospecting', 0, 2),
  ('30000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-000000000002', 'Batmobile', 'prospecting', 0, 1);
insert into public.offer_sets (ask_id, item_id) values
  ('30000000-0000-4000-8000-0000000000b1', '20000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-0000000000b1', '20000000-0000-4000-8000-000000000002'),
  ('30000000-0000-4000-8000-0000000000b2', '20000000-0000-4000-8000-000000000003'),
  ('30000000-0000-4000-8000-0000000000b2', '20000000-0000-4000-8000-000000000004');

-- Galaxy Explorer to Jordan; Jordan's Items to Maya, each filling p_asks[i] of hers.
create function pg_temp.bundle(p_items text[], p_asks text[], p_cash int default 0) returns jsonb
language sql as $$
  select jsonb_build_object(
    'item_legs',
      jsonb_build_array(jsonb_build_object(
        'giver', '00000000-0000-4000-8000-000000000002', 'receiver', '00000000-0000-4000-8000-000000000001',
        'item_id', '20000000-0000-4000-8000-000000000003',
        'ask_id', '30000000-0000-4000-8000-0000000000b1', 'giver_ask_id', '30000000-0000-4000-8000-0000000000b2'))
      || (select jsonb_agg(jsonb_build_object(
            'giver', '00000000-0000-4000-8000-000000000001', 'receiver', '00000000-0000-4000-8000-000000000002',
            'item_id', p_items[i], 'ask_id', p_asks[i], 'giver_ask_id', '30000000-0000-4000-8000-0000000000b1'))
            from generate_subscripts(p_items, 1) i),
    'cash_legs', case when p_cash > 0 then jsonb_build_array(jsonb_build_object(
      'payer', '00000000-0000-4000-8000-000000000001', 'payee', '00000000-0000-4000-8000-000000000002',
      'amount_cents', p_cash)) else '[]'::jsonb end
  );
$$;

-- 1. Rules a bundle must keep.
do $$
declare
  bat constant text := '20000000-0000-4000-8000-000000000001';
  zelda constant text := '20000000-0000-4000-8000-000000000002';
  mario constant text := '20000000-0000-4000-8000-000000000004';
  two constant text := '30000000-0000-4000-8000-0000000000b2';
  batmobile_ask constant text := '30000000-0000-4000-8000-0000000000b3';
  d jsonb;
  r text;
begin
  -- The Batmobile Ask takes 1, so 2 Items for it are refused.
  r := public.stage_deal(pg_temp.bundle(array[bat, zelda], array[batmobile_ask, batmobile_ask]))->>'result';
  if r <> 'invalid' then raise exception 'over max_items: %', r; end if;
  -- An Item can't appear twice.
  r := public.stage_deal(pg_temp.bundle(array[zelda, zelda], array[two, two]))->>'result';
  if r <> 'invalid' then raise exception 'same Item twice: %', r; end if;
  -- Jordan gives from 2 offer sets.
  d := pg_temp.bundle(array[bat, zelda], array[two, two]);
  r := public.stage_deal(jsonb_set(d, '{item_legs,2,giver_ask_id}', to_jsonb(batmobile_ask)))->>'result';
  if r <> 'invalid' then raise exception '2 offer sets: %', r; end if;
  -- Maya gives Mario Wonder to Jordan too, but she already gives Galaxy Explorer for b2.
  -- It's fine to hand several Items, so this is refused only because Jordan's Ask takes 1.
  d := jsonb_set(d, '{item_legs}', (d->'item_legs') || jsonb_build_array(jsonb_build_object(
    'giver', '00000000-0000-4000-8000-000000000002', 'receiver', '00000000-0000-4000-8000-000000000001',
    'item_id', mario, 'ask_id', '30000000-0000-4000-8000-0000000000b1', 'giver_ask_id', two)));
  r := public.stage_deal(d)->>'result';
  if r <> 'invalid' then raise exception 'Jordan''s Ask takes 1: %', r; end if;
  -- Over Jordan's $10 ceiling on the Ask he gives for.
  r := public.stage_deal(pg_temp.bundle(array[bat, zelda], array[two, two], 1500))->>'result';
  if r <> 'over_ceiling' then raise exception 'over ceiling: %', r; end if;

  if exists (select 1 from public.deals) then raise exception 'a refused Deal was written'; end if;
end $$;

-- 2. 2 Items for 1: Jordan's Batmobile and Zelda for Galaxy Explorer, plus $5.
do $$
declare
  r jsonb := public.stage_deal(pg_temp.bundle(
    array['20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002'],
    array['30000000-0000-4000-8000-0000000000b2', '30000000-0000-4000-8000-0000000000b2'], 500));
  deal uuid := (r->>'deal_id')::uuid;
begin
  if r->>'result' <> 'ok' then raise exception 'bundle failed: %', r; end if;
  if (select count(*) from public.items where reserved_by_deal_id = deal) <> 3 then
    raise exception 'all 3 Items should be held';
  end if;
  if (select count(*) from public.deal_legs
       where deal_id = deal and giver_id = '00000000-0000-4000-8000-000000000001' and item_id is not null
         and giver_ask_id = '30000000-0000-4000-8000-0000000000b1') <> 2 then
    raise exception 'Jordan''s 2 legs should record the offer set they came from';
  end if;
  if (select status from public.asks where id = '30000000-0000-4000-8000-0000000000b3') <> 'prospecting' then
    raise exception 'the Batmobile Ask was not part of this Deal';
  end if;
end $$;

-- 3. An extra for another Ask: Zelda for Maya's b2 and the Batmobile for her Batmobile
--    Ask. Both of her Asks are filled.
do $$
declare
  r jsonb;
begin
  perform public.close_deal((select id from public.deals), 'cancelled');
  r := public.stage_deal(pg_temp.bundle(
    array['20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001'],
    array['30000000-0000-4000-8000-0000000000b2', '30000000-0000-4000-8000-0000000000b3']));
  if r->>'result' <> 'ok' then raise exception 'extra Ask failed: %', r; end if;
  if exists (select 1 from public.asks where id in (
       '30000000-0000-4000-8000-0000000000b1', '30000000-0000-4000-8000-0000000000b2',
       '30000000-0000-4000-8000-0000000000b3') and status <> 'proposed') then
    raise exception 'every filled Ask should be proposed';
  end if;
end $$;

select 'deal bundle tests passed';
rollback;

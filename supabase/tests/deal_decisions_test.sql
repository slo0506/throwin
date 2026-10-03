-- Approving and declining Deals (Milestone 3).
-- Runs inside a transaction that is rolled back, so later test files see the seed as is.
-- From seed.sql: Jordan ...0001 (Zelda ...0002) and Maya ...0002 (Galaxy Explorer ...0003)
-- share the Thursday Lego Circle.
\set ON_ERROR_STOP on

begin;

-- Both Items are showcase, so staging goes straight to pending_approvals.
update public.items set photo_score = 80, missing_angles = '{}'
 where id in ('20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003');

insert into public.asks (id, user_id, raw_text, status, cash_ceiling_cents) values
  ('30000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'Galaxy Explorer', 'prospecting', 5000),
  ('30000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000002', 'Zelda', 'prospecting', 0);
insert into public.offer_sets (ask_id, item_id) values
  ('30000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000002'),
  ('30000000-0000-4000-8000-0000000000a2', '20000000-0000-4000-8000-000000000003');

create function pg_temp.stage() returns uuid language plpgsql as $$
declare r jsonb;
begin
  r := public.stage_deal(jsonb_build_object(
    'item_legs', jsonb_build_array(
      jsonb_build_object('giver', '00000000-0000-4000-8000-000000000002', 'receiver', '00000000-0000-4000-8000-000000000001',
                         'item_id', '20000000-0000-4000-8000-000000000003',
                         'ask_id', '30000000-0000-4000-8000-0000000000a1', 'giver_ask_id', '30000000-0000-4000-8000-0000000000a2'),
      jsonb_build_object('giver', '00000000-0000-4000-8000-000000000001', 'receiver', '00000000-0000-4000-8000-000000000002',
                         'item_id', '20000000-0000-4000-8000-000000000002',
                         'ask_id', '30000000-0000-4000-8000-0000000000a2', 'giver_ask_id', '30000000-0000-4000-8000-0000000000a1')),
    'cash_legs', jsonb_build_array(jsonb_build_object(
      'payer', '00000000-0000-4000-8000-000000000001', 'payee', '00000000-0000-4000-8000-000000000002', 'amount_cents', 2000))));
  if r->>'result' <> 'ok' then raise exception 'stage failed: %', r; end if;
  return (r->>'deal_id')::uuid;
end $$;

-- 1. Declining cancels the Deal, frees the Items, sends the Asks back to work and
--    remembers what was turned down.
do $$
declare
  jordan constant uuid := '00000000-0000-4000-8000-000000000001';
  maya constant uuid := '00000000-0000-4000-8000-000000000002';
  deal uuid := pg_temp.stage();
  r jsonb;
begin
  if (select status from public.deals where id = deal) <> 'pending_approvals' then
    raise exception 'expected pending_approvals';
  end if;
  r := public.decline_deal('00000000-0000-4000-8000-000000000003', deal, null);
  if r->>'result' <> 'not_found' then raise exception 'an outsider declined: %', r; end if;

  r := public.decline_deal(maya, deal, '  Not into Zelda anymore  ');
  if r->>'result' <> 'ok' or r->>'status' <> 'cancelled' then raise exception 'decline: %', r; end if;
  if (select status from public.deals where id = deal) <> 'cancelled' then raise exception 'not cancelled'; end if;
  if (select decline_reason from public.deal_participants where deal_id = deal and user_id = maya) <> 'Not into Zelda anymore' then
    raise exception 'reason not stored';
  end if;
  if exists (select 1 from public.items where reserved_by_deal_id is not null) then raise exception 'Items still held'; end if;
  if exists (select 1 from public.asks where id in ('30000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a2') and status <> 'prospecting') then
    raise exception 'Asks should be prospecting';
  end if;
  -- Maya turned down Zelda for her Ask; Jordan turned down nothing.
  if (select array_agg(ask_id::text || '>' || item_id::text) from public.ask_exclusions)
     <> array['30000000-0000-4000-8000-0000000000a2>20000000-0000-4000-8000-000000000002'] then
    raise exception 'wrong exclusions';
  end if;

  r := public.approve_deal(jordan, deal, '{}');
  if r->>'result' <> 'closed' then raise exception 'approved a cancelled Deal: %', r; end if;
end $$;

-- 2. The re-match no longer offers Maya what she turned down, but still offers Jordan his.
do $$
declare
  v extensions.vector := ('[' || array_to_string(array_fill(0.5::real, array[1024]), ',') || ']')::extensions.vector;
begin
  insert into public.ask_embeddings (ask_id, model, embedding, source_hash) values
    ('30000000-0000-4000-8000-0000000000a1', 'm', v, 'h'),
    ('30000000-0000-4000-8000-0000000000a2', 'm', v, 'h');
  insert into public.item_embeddings (item_id, model, embedding) values
    ('20000000-0000-4000-8000-000000000002', 'm', v),
    ('20000000-0000-4000-8000-000000000003', 'm', v);
  if exists (select 1 from public.circle_want_candidates('10000000-0000-4000-8000-000000000001', 'm')
              where ask_id = '30000000-0000-4000-8000-0000000000a2') then
    raise exception 'Maya was offered the Item she declined';
  end if;
  if not exists (select 1 from public.circle_want_candidates('10000000-0000-4000-8000-000000000001', 'm')
                  where ask_id = '30000000-0000-4000-8000-0000000000a1'
                    and item_id = '20000000-0000-4000-8000-000000000003') then
    raise exception 'Jordan should still be offered Galaxy Explorer';
  end if;
end $$;

-- 3. When everyone approves, the Deal is approved and the Asks accepted.
do $$
declare
  jordan constant uuid := '00000000-0000-4000-8000-000000000001';
  maya constant uuid := '00000000-0000-4000-8000-000000000002';
  deal uuid := pg_temp.stage();
  r jsonb;
begin
  r := public.approve_deal(jordan, deal, '{"you_give": "Zelda"}');
  if r->>'result' <> 'ok' or r->>'status' <> 'pending_approvals' then raise exception 'first approval: %', r; end if;
  if (select sheet_snapshot->>'you_give' from public.deal_participants where deal_id = deal and user_id = jordan) <> 'Zelda'
     or (select approved_at from public.deal_participants where deal_id = deal and user_id = jordan) is null then
    raise exception 'approval not recorded';
  end if;
  r := public.approve_deal(jordan, deal, '{}');
  if r->>'result' <> 'decided' then raise exception 'approved twice: %', r; end if;
  r := public.decline_deal(jordan, deal, 'changed my mind');
  if r->>'result' <> 'decided' then raise exception 'declined after approving: %', r; end if;

  r := public.approve_deal(maya, deal, '{}');
  if r->>'result' <> 'ok' or r->>'status' <> 'approved' then raise exception 'last approval: %', r; end if;
  if (select status from public.deals where id = deal) <> 'approved' then raise exception 'Deal not approved'; end if;
  if exists (select 1 from public.asks where id in ('30000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a2') and status <> 'accepted') then
    raise exception 'Asks should be accepted';
  end if;
  -- Items stay held for the handoff, and approved Deals never expire.
  if (select count(*) from public.items where reserved_by_deal_id = deal) <> 2 then raise exception 'Items released early'; end if;
  update public.deals set expires_at = now() - interval '1 minute' where id = deal;
  if public.expire_deals() <> 0 then raise exception 'an approved Deal expired'; end if;
end $$;

-- 4. Staged and expired Deals can't be decided.
do $$
declare
  deal uuid;
  r jsonb;
begin
  update public.items set reserved_by_deal_id = null, status = 'on_shelf' where reserved_by_deal_id is not null;
  update public.asks set status = 'prospecting'
   where id in ('30000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a2');
  deal := pg_temp.stage();
  update public.deals set status = 'staged' where id = deal;
  r := public.approve_deal('00000000-0000-4000-8000-000000000001', deal, '{}');
  if r->>'result' <> 'not_found' then raise exception 'a staged Deal was approved: %', r; end if;
  update public.deals set status = 'pending_approvals', expires_at = now() - interval '1 minute' where id = deal;
  r := public.approve_deal('00000000-0000-4000-8000-000000000001', deal, '{}');
  if r->>'result' <> 'closed' then raise exception 'an expired Deal was approved: %', r; end if;
end $$;

-- 5. Only the server records decisions, and nobody reads exclusions directly.
do $$
begin
  if has_function_privilege('authenticated', 'public.approve_deal(uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.decline_deal(uuid, uuid, text)', 'execute') then
    raise exception 'decision functions must be service role only';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.ask_exclusions'::regclass)
     or exists (select 1 from pg_policies where tablename = 'ask_exclusions') then
    raise exception 'ask_exclusions must have RLS and no policies';
  end if;
end $$;

select 'deal decision tests passed';
rollback;

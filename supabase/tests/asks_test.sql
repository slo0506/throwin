-- Asks, offer sets and taste facts (Milestone 2).
-- Runs inside a transaction that is rolled back, so later test files see the seed as is.
-- Users from seed.sql: Jordan ...0001 (Items ...0001 and ...0002) and Maya ...0002.
\set ON_ERROR_STOP on

begin;

insert into public.deals (id) values ('40000000-0000-4000-8000-000000000001');

insert into public.items (id, owner_id, status, title, value_low_cents, value_mid_cents, value_high_cents, reserved_by_deal_id)
values
  ('20000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000001', 'draft', 'Draft lamp', 1000, 1500, 2000, null),
  ('20000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000001', 'reserved', 'Held set', 1000, 1500, 2000, '40000000-0000-4000-8000-000000000001');

insert into public.asks (id, user_id, raw_text)
values
  ('30000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000001', 'the big Lego Batmobile'),
  ('30000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000002', 'a Switch game');

-- 1. Title column: nullable, at most 120 characters.
do $$
begin
  update public.asks set title = 'LEGO Batman Batmobile Tumbler 76240' where id = '30000000-0000-4000-8000-000000000061';
  update public.asks set title = null where id = '30000000-0000-4000-8000-000000000061';
  begin
    update public.asks set title = repeat('x', 121) where id = '30000000-0000-4000-8000-000000000061';
    raise exception 'a 121 character title was accepted';
  exception when check_violation then null;
  end;
end $$;

-- 2. patch_ask: ownership, offer set rules and status moves.
do $$
declare
  jordan constant uuid := '00000000-0000-4000-8000-000000000001';
  maya constant uuid := '00000000-0000-4000-8000-000000000002';
  ask constant uuid := '30000000-0000-4000-8000-000000000061';
  r jsonb;
begin
  r := public.patch_ask(maya, ask, '{"raw_text": "mine now"}');
  if r->>'result' <> 'not_found' then raise exception 'another user edited the Ask: %', r; end if;

  -- A target moves drafting to offering, and sets the title.
  r := public.patch_ask(jordan, ask, '{"target": {"kind": "exact", "name": "Batmobile Tumbler"}, "title": "Batmobile Tumbler"}');
  if r->>'result' <> 'ok' then raise exception 'target patch failed: %', r; end if;
  if (select status from public.asks where id = ask) <> 'offering' then
    raise exception 'a target should move drafting to offering';
  end if;
  if (select title from public.asks where id = ask) <> 'Batmobile Tumbler' then
    raise exception 'title was not set';
  end if;

  -- Someone else's Item, a draft Item and a reserved Item are all refused, and change nothing.
  foreach r in array array[
    '{"offer_item_ids": ["20000000-0000-4000-8000-000000000003"]}'::jsonb,
    '{"offer_item_ids": ["20000000-0000-4000-8000-000000000061"]}'::jsonb,
    '{"offer_item_ids": ["20000000-0000-4000-8000-000000000062"]}'::jsonb,
    '{"offer_item_ids": ["20000000-0000-4000-8000-000000000002", "20000000-0000-4000-8000-000000000003"], "raw_text": "changed"}'::jsonb
  ] loop
    if public.patch_ask(jordan, ask, r)->>'result' <> 'invalid_offer_item' then
      raise exception 'invalid offer accepted: %', r;
    end if;
  end loop;
  if exists (select 1 from public.offer_sets where ask_id = ask) then
    raise exception 'a refused offer set left rows behind';
  end if;
  if (select raw_text from public.asks where id = ask) <> 'the big Lego Batmobile' then
    raise exception 'a refused patch changed other fields';
  end if;

  -- A valid, non-empty offer set moves offering to prospecting.
  r := public.patch_ask(jordan, ask, '{"offer_item_ids": ["20000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002"], "cash_ceiling_cents": 2000}');
  if r->>'result' <> 'ok' then raise exception 'valid offer set refused: %', r; end if;
  if (select count(*) from public.offer_sets where ask_id = ask) <> 2 then
    raise exception 'expected 2 offer Items';
  end if;
  if (select status from public.asks where id = ask) <> 'prospecting' then
    raise exception 'a non-empty offer set should move offering to prospecting';
  end if;

  -- Replacing the offer set drops Items left out.
  r := public.patch_ask(jordan, ask, '{"offer_item_ids": ["20000000-0000-4000-8000-000000000002"], "deadline": "2026-10-20T00:00:00Z"}');
  if (select array_agg(item_id) from public.offer_sets where ask_id = ask) <> array['20000000-0000-4000-8000-000000000002'::uuid] then
    raise exception 'offer set was not replaced';
  end if;
  if (select deadline from public.asks where id = ask) <> '2026-10-20T00:00:00Z'::timestamptz then
    raise exception 'deadline not set';
  end if;
  r := public.patch_ask(jordan, ask, '{"deadline": null}');
  if (select deadline from public.asks where id = ask) is not null then
    raise exception 'deadline not cleared';
  end if;

  -- Only cancelled is accepted as a status, and a cancelled Ask is closed.
  if public.patch_ask(jordan, ask, '{"status": "fulfilled"}')->>'result' <> 'invalid_status' then
    raise exception 'a client set a status other than cancelled';
  end if;
  r := public.patch_ask(jordan, ask, '{"status": "cancelled"}');
  if (select status from public.asks where id = ask) <> 'cancelled' then
    raise exception 'cancel failed';
  end if;
  if public.patch_ask(jordan, ask, '{"status": "cancelled"}')->>'result' <> 'ok' then
    raise exception 'cancelling twice should be ok';
  end if;
  if public.patch_ask(jordan, ask, '{"raw_text": "again"}')->>'result' <> 'ask_closed' then
    raise exception 'a cancelled Ask was edited';
  end if;
end $$;

-- 3. patch_ask is server only.
do $$
begin
  if has_function_privilege('authenticated', 'public.patch_ask(uuid, uuid, jsonb)', 'execute') then
    raise exception 'authenticated can call patch_ask';
  end if;
  if has_function_privilege('anon', 'public.patch_ask(uuid, uuid, jsonb)', 'execute') then
    raise exception 'anon can call patch_ask';
  end if;
end $$;

-- 4. Asks and offer sets stay owner-only under RLS.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
do $$
begin
  if exists (select 1 from public.asks where user_id <> '00000000-0000-4000-8000-000000000002') then
    raise exception 'RLS leak: another user''s Ask is visible';
  end if;
  if exists (select 1 from public.offer_sets) then
    raise exception 'RLS leak: another user''s offer set is visible';
  end if;
end $$;
reset role;

-- 5. Taste facts: categories, keys, 1 active row per key and value, 40 active at most.
do $$
declare
  jordan constant uuid := '00000000-0000-4000-8000-000000000001';
  first_id uuid;
begin
  insert into public.taste_facts (user_id, key, value, category, source, always_on)
  values (jordan, 'never_trade', 'Millennium Falcon', 'limits', 'intake', true)
  returning id into first_id;
  if (select source from public.taste_facts where id = first_id) <> 'intake' then
    raise exception 'source not stored';
  end if;

  begin
    insert into public.taste_facts (user_id, key, value, category) values (jordan, 'x', 'y', 'health');
    raise exception 'unknown category accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.taste_facts (user_id, key, value, category) values (jordan, 'Never Trade', 'y', 'limits');
    raise exception 'non snake_case key accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.taste_facts (user_id, key, value, category, source) values (jordan, 'x', 'y', 'limits', 'gossip');
    raise exception 'unknown source accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.taste_facts (user_id, key, value, category) values (jordan, 'never_trade', 'millennium falcon', 'limits');
    raise exception 'duplicate active fact accepted';
  exception when unique_violation then null;
  end;

  -- A deleted fact frees its key and value (the extractor, not the database, refuses to
  -- write it again).
  update public.taste_facts set status = 'deleted' where id = first_id;
  insert into public.taste_facts (user_id, key, value, category) values (jordan, 'never_trade', 'Millennium Falcon', 'limits');

  insert into public.taste_facts (user_id, key, value, category)
  select jordan, 'interest_' || g, 'Thing ' || g, 'interests' from generate_series(1, 39) g;
  if (select count(*) from public.taste_facts where user_id = jordan and status = 'active') <> 40 then
    raise exception 'expected 40 active facts';
  end if;
  begin
    insert into public.taste_facts (user_id, key, value, category) values (jordan, 'one_more', 'Too many', 'style');
    raise exception 'a 41st active fact was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.taste_facts set status = 'active' where id = first_id;
    raise exception 'reactivating a fact past the cap was accepted';
  exception when check_violation then null;
  end;
  -- Superseding one makes room.
  update public.taste_facts set status = 'superseded' where user_id = jordan and key = 'interest_1';
  insert into public.taste_facts (user_id, key, value, category) values (jordan, 'one_more', 'Now it fits', 'style');
end $$;

select 'asks tests passed';
rollback;

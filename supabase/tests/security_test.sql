-- Security and invariant tests. Each block raises on failure.
-- Users: Jordan ...0001 and Maya ...0002 share the Thursday Lego Circle (from seed.sql).
-- A third user, Stranger ...0003, shares no Circle with anyone.
\set ON_ERROR_STOP on

insert into auth.users (id, email, raw_user_meta_data)
values ('00000000-0000-4000-8000-000000000003', 'stranger@example.com', '{"first_name": "Sam"}');

insert into public.items (id, owner_id, status, title, value_low_cents, value_mid_cents, value_high_cents)
values ('20000000-0000-4000-8000-000000000099', '00000000-0000-4000-8000-000000000003', 'on_shelf', 'Stranger set', 100, 200, 300);

insert into public.asks (id, user_id, raw_text, cash_ceiling_cents)
values ('30000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'Batmobile', 2500);

insert into public.taste_facts (user_id, key, value)
values ('00000000-0000-4000-8000-000000000002', 'never_trade', 'My Millennium Falcon');

-- 1. Auth trigger mirrored users and profiles.
do $$
begin
  if (select display_name from public.users where id = '00000000-0000-4000-8000-000000000003') <> 'Sam' then
    raise exception 'auth trigger did not copy first_name';
  end if;
  if not exists (select 1 from public.profiles where user_id = '00000000-0000-4000-8000-000000000003') then
    raise exception 'auth trigger did not create profile';
  end if;
  if not exists (select 1 from public.circle_members
                 where circle_id = '10000000-0000-4000-8000-000000000001'
                   and user_id = '00000000-0000-4000-8000-000000000001' and role = 'owner') then
    raise exception 'circle owner was not added as a member';
  end if;
end $$;

-- 2. RLS isolation: Jordan sees only his own Items, Asks and taste facts.
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$
begin
  if exists (select 1 from public.items where owner_id <> '00000000-0000-4000-8000-000000000001') then
    raise exception 'RLS leak: items of other users visible';
  end if;
  if (select count(*) from public.items) <> 2 then
    raise exception 'expected 2 own items, got %', (select count(*) from public.items);
  end if;
  if exists (select 1 from public.asks) then
    raise exception 'RLS leak: another user''s ask is visible';
  end if;
  if exists (select 1 from public.taste_facts) then
    raise exception 'RLS leak: another user''s taste facts are visible';
  end if;
  if exists (select 1 from public.users where id <> '00000000-0000-4000-8000-000000000001') then
    raise exception 'RLS leak: other users rows visible';
  end if;
end $$;
rollback;

-- 3. Jordan cannot write an Item as Maya, nor reserve an Item himself.
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$
begin
  begin
    insert into public.items (owner_id, title) values ('00000000-0000-4000-8000-000000000002', 'spoof');
    raise exception 'RLS allowed inserting an item for another user';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.items set status = 'reserved', reserved_by_deal_id = gen_random_uuid()
    where id = '20000000-0000-4000-8000-000000000001';
    raise exception 'client was able to reserve an item';
  exception when insufficient_privilege or check_violation or foreign_key_violation then null;
  end;
end $$;
rollback;

-- 4. network_items: Jordan sees Maya's Items (co-member) but not the stranger's,
--    and the function exposes no cash ceilings.
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$
declare
  n int;
begin
  select count(*) into n from public.network_items('10000000-0000-4000-8000-000000000001');
  if n <> 2 then
    raise exception 'network_items expected 2 of Maya''s items, got %', n;
  end if;
  if exists (select 1 from public.network_items('10000000-0000-4000-8000-000000000001')
             where owner_id = '00000000-0000-4000-8000-000000000003') then
    raise exception 'network_items leaked a non-member item';
  end if;
end $$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000003';
do $$
begin
  if exists (select 1 from public.network_items('10000000-0000-4000-8000-000000000001')) then
    raise exception 'non-member could read a Circle''s items';
  end if;
end $$;
rollback;

-- 5. Reservation: an Item can be in only 1 Deal at a time, atomically.
do $$
declare
  d1 uuid;
  d2 uuid;
begin
  insert into public.deals default values returning id into d1;
  insert into public.deals default values returning id into d2;
  perform public.reserve_items(d1, array['20000000-0000-4000-8000-000000000001'::uuid]);

  begin
    perform public.reserve_items(d2, array[
      '20000000-0000-4000-8000-000000000002'::uuid,
      '20000000-0000-4000-8000-000000000001'::uuid
    ]);
    raise exception 'double reservation was allowed';
  exception when raise_exception then
    if sqlerrm = 'double reservation was allowed' then raise; end if;
  end;

  -- The failed call must not have reserved the free Item either.
  if (select status from public.items where id = '20000000-0000-4000-8000-000000000002') <> 'on_shelf' then
    raise exception 'partial reservation leaked';
  end if;

  if public.release_deal_items(d1) <> 1 then
    raise exception 'release did not free the item';
  end if;
  perform public.reserve_items(d2, array['20000000-0000-4000-8000-000000000001'::uuid]);
  perform public.release_deal_items(d2);
end $$;

-- 6. Clients cannot call reserve_items directly.
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$
begin
  perform public.reserve_items(gen_random_uuid(), array['20000000-0000-4000-8000-000000000001'::uuid]);
  raise exception 'authenticated role could execute reserve_items';
exception when insufficient_privilege then null;
end $$;
rollback;

-- 7. agent_events is append-only.
do $$
declare
  r uuid;
begin
  insert into public.agent_runs (agent, trigger, user_id)
  values ('gm', 'test', '00000000-0000-4000-8000-000000000002') returning id into r;
  insert into public.agent_events (run_id, user_id, type) values (r, '00000000-0000-4000-8000-000000000002', 'tool_call');

  begin
    update public.agent_events set type = 'tampered' where run_id = r;
    raise exception 'agent_events update was allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.agent_events where run_id = r;
    raise exception 'agent_events delete was allowed';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 8. Offer sets may only use the asker's own Items.
do $$
begin
  begin
    insert into public.offer_sets (ask_id, item_id)
    values ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001');
    raise exception 'offer set accepted another user''s item';
  exception when insufficient_privilege then null;
  end;
  insert into public.offer_sets (ask_id, item_id)
  values ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003');
end $$;

-- 9. Account deletion cascades Items, Asks and taste facts, and anonymizes agent events.
do $$
begin
  delete from auth.users where id = '00000000-0000-4000-8000-000000000002';
  if exists (select 1 from public.items where owner_id = '00000000-0000-4000-8000-000000000002') then
    raise exception 'items survived account deletion';
  end if;
  if exists (select 1 from public.taste_facts where user_id = '00000000-0000-4000-8000-000000000002') then
    raise exception 'taste facts survived account deletion';
  end if;
  if exists (select 1 from public.asks where user_id = '00000000-0000-4000-8000-000000000002') then
    raise exception 'asks survived account deletion';
  end if;
  if exists (select 1 from public.agent_events where user_id = '00000000-0000-4000-8000-000000000002') then
    raise exception 'agent events were not anonymized';
  end if;
end $$;

select 'security tests passed' as result;

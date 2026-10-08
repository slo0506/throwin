-- Demand counts: what people in the user's Circles want, as counts only.
-- Runs inside a transaction that is rolled back, so later test files see the seed as is.
-- From seed.sql: Jordan ...0001 (Batmobile ...0001, Zelda ...0002) and Maya ...0002 share
-- the Thursday Lego Circle ...0001.
\set ON_ERROR_STOP on

begin;

create function pg_temp.vec(k int) returns extensions.vector language sql as $$
  select ('[' || array_to_string(array(
    select case when g = k then 1 else 0 end from generate_series(1, 1024) g
  ), ',') || ']')::extensions.vector;
$$;

-- Sam joins too.
insert into auth.users (id, email, raw_user_meta_data)
values ('00000000-0000-4000-8000-0000000000d1', 'sam@example.com', '{"first_name": "Sam"}');
insert into public.circle_members (circle_id, user_id, role)
values ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000d1', 'member');

-- Maya and Sam both want a Switch game; Maya wants Galaxy Explorer; Sam wants Kobe 11s;
-- Jordan's own Ask never counts.
insert into public.asks (id, user_id, raw_text, status, target) values
  ('30000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000002', 'switch games', 'prospecting',
   '{"kind": "category", "name": "Nintendo Switch game", "category": "video_games"}'),
  ('30000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000d1', 'a switch game', 'offering',
   '{"kind": "category", "name": "nintendo switch game ", "category": "video_games"}'),
  ('30000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-000000000002', 'space lego', 'prospecting',
   '{"kind": "exact", "name": "LEGO Batmobile Tumbler", "category": "toys/lego"}'),
  ('30000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-0000000000d1', 'kobes', 'prospecting',
   '{"kind": "exact", "name": "Nike Kobe 11", "category": "sneakers"}'),
  ('30000000-0000-4000-8000-0000000000d5', '00000000-0000-4000-8000-000000000001', 'anything', 'prospecting',
   '{"kind": "category", "name": "Nintendo Switch game", "category": "video_games"}');

insert into public.ask_embeddings (ask_id, model, embedding, source_hash) values
  ('30000000-0000-4000-8000-0000000000d1', 'voyage-multimodal-3.5', pg_temp.vec(6), 'a'),
  ('30000000-0000-4000-8000-0000000000d2', 'voyage-multimodal-3.5', pg_temp.vec(6), 'b'),
  ('30000000-0000-4000-8000-0000000000d3', 'voyage-multimodal-3.5', pg_temp.vec(5), 'c'),
  ('30000000-0000-4000-8000-0000000000d4', 'voyage-multimodal-3.5', pg_temp.vec(7), 'd');
-- Jordan's Batmobile sits near the LEGO want, his Zelda near the Switch want.
insert into public.item_embeddings (item_id, model, embedding) values
  ('20000000-0000-4000-8000-000000000001', 'voyage-multimodal-3.5', pg_temp.vec(5)),
  ('20000000-0000-4000-8000-000000000002', 'voyage-multimodal-3.5', pg_temp.vec(6))
on conflict (item_id, model) do update set embedding = excluded.embedding;

-- 1. Shared wants and wants the user could fill show; a lone want they can't fill doesn't.
do $$
declare
  jordan constant uuid := '00000000-0000-4000-8000-000000000001';
  got text;
begin
  select string_agg(format('%s|%s|%s', label, askers, item_ids), ';' order by ord)
    into got
    from (select *, row_number() over () as ord from public.circle_demand(jordan)) d;
  if got is distinct from
     'Nintendo Switch game|2|{20000000-0000-4000-8000-000000000002};LEGO Batmobile Tumbler|1|{20000000-0000-4000-8000-000000000001}' then
    raise exception 'unexpected demand: %', got;
  end if;
  if (select count(*) from public.circle_demand(jordan, 1)) <> 3 then
    raise exception 'at 1 asker, the Kobe want shows too';
  end if;
end $$;

-- 2. Blocked people don't count, and an Item that's held or not available doesn't fit.
do $$
declare
  jordan constant uuid := '00000000-0000-4000-8000-000000000001';
begin
  insert into public.blocks (blocker_id, blocked_id) values (jordan, '00000000-0000-4000-8000-0000000000d1');
  if (select askers from public.circle_demand(jordan) where label = 'Nintendo Switch game') <> 1 then
    raise exception 'a blocked person still counts';
  end if;
  delete from public.blocks where blocker_id = jordan;
  update public.items set willingness = 'not_available' where id = '20000000-0000-4000-8000-000000000002';
  if (select item_ids from public.circle_demand(jordan) where label = 'Nintendo Switch game') <> '{}' then
    raise exception 'a not-available Item still fits';
  end if;
end $$;

-- 3. Only the server reads demand.
do $$
begin
  if has_function_privilege('authenticated', 'public.circle_demand(uuid, int, real, int)', 'execute')
     or has_function_privilege('anon', 'public.circle_demand(uuid, int, real, int)', 'execute') then
    raise exception 'circle_demand must be service role only';
  end if;
end $$;

select 'demand tests passed';
rollback;

-- The Prospector's database side (Milestone 3): want candidates, job queueing, triggers.
-- Runs inside a transaction that is rolled back, so later test files see the seed as is.
-- From seed.sql: Jordan ...0001 (Batmobile ...0001, Zelda ...0002) and Maya ...0002
-- (Galaxy Explorer ...0003, Mario Wonder ...0004) share the Thursday Lego Circle ...0001.
\set ON_ERROR_STOP on

begin;

-- A 1024-dimension vector that is 1 at position k and 0 elsewhere, so similarities are exact.
create function pg_temp.vec(k int) returns extensions.vector language sql as $$
  select ('[' || array_to_string(array(
    select case when g = k then 1 else 0 end from generate_series(1, 1024) g
  ), ',') || ']')::extensions.vector;
$$;

-- Jordan wants something like Galaxy Explorer and offers Zelda. Maya wants something like
-- Zelda and offers Galaxy Explorer and Mario. Jordan's Batmobile looks like Maya's want but
-- isn't in any offer set.
insert into public.asks (id, user_id, raw_text, status, cash_ceiling_cents) values
  ('30000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000001', 'a space set', 'prospecting', 2000),
  ('30000000-0000-4000-8000-000000000082', '00000000-0000-4000-8000-000000000002', 'a Zelda game', 'prospecting', 500);

insert into public.offer_sets (ask_id, item_id) values
  ('30000000-0000-4000-8000-000000000081', '20000000-0000-4000-8000-000000000002'),
  ('30000000-0000-4000-8000-000000000082', '20000000-0000-4000-8000-000000000003'),
  ('30000000-0000-4000-8000-000000000082', '20000000-0000-4000-8000-000000000004');

insert into public.ask_embeddings (ask_id, model, embedding, source_hash) values
  ('30000000-0000-4000-8000-000000000081', 'voyage-multimodal-3.5', pg_temp.vec(1), 'h1'),
  ('30000000-0000-4000-8000-000000000082', 'voyage-multimodal-3.5', pg_temp.vec(3), 'h2');

insert into public.item_embeddings (item_id, model, embedding) values
  ('20000000-0000-4000-8000-000000000001', 'voyage-multimodal-3.5', pg_temp.vec(3)),
  ('20000000-0000-4000-8000-000000000002', 'voyage-multimodal-3.5', pg_temp.vec(3)),
  ('20000000-0000-4000-8000-000000000003', 'voyage-multimodal-3.5', pg_temp.vec(1)),
  ('20000000-0000-4000-8000-000000000004', 'voyage-multimodal-3.5', pg_temp.vec(2))
on conflict (item_id, model) do update set embedding = excluded.embedding;

-- 1. Candidates: each Ask sees only Items others offer, nearest first, never its own.
do $$
declare
  circle constant uuid := '10000000-0000-4000-8000-000000000001';
  got text;
begin
  select string_agg(ask_id::text || '>' || item_id::text || '@' || round(similarity::numeric, 2), ' ' order by ask_id, similarity desc)
    into got
    from public.circle_want_candidates(circle, 'voyage-multimodal-3.5');
  if got <> '30000000-0000-4000-8000-000000000081>20000000-0000-4000-8000-000000000003@1.00 '
         || '30000000-0000-4000-8000-000000000081>20000000-0000-4000-8000-000000000004@0.00 '
         || '30000000-0000-4000-8000-000000000082>20000000-0000-4000-8000-000000000002@1.00' then
    raise exception 'unexpected candidates: %', got;
  end if;

  -- The matcher's fields come along: the giver's Ask, the value and the wanter's ceiling.
  if not exists (
    select 1 from public.circle_want_candidates(circle, 'voyage-multimodal-3.5')
     where ask_id = '30000000-0000-4000-8000-000000000081'
       and item_id = '20000000-0000-4000-8000-000000000003'
       and giver_id = '00000000-0000-4000-8000-000000000002'
       and giver_ask_id = '30000000-0000-4000-8000-000000000082'
       and value_mid_cents = 8500 and cash_ceiling_cents = 2000
  ) then
    raise exception 'candidate fields are wrong';
  end if;

  -- p_per_ask limits each Ask's list.
  if (select count(*) from public.circle_want_candidates(circle, 'voyage-multimodal-3.5', 1)
       where ask_id = '30000000-0000-4000-8000-000000000081') <> 1 then
    raise exception 'p_per_ask was not applied';
  end if;
  -- Another model's vectors don't mix in.
  if exists (select 1 from public.circle_want_candidates(circle, 'some-other-model')) then
    raise exception 'candidates crossed embedding models';
  end if;
end $$;

-- 2. Reserved and not-available Items, inactive offers and blocks all remove candidates.
do $$
declare
  circle constant uuid := '10000000-0000-4000-8000-000000000001';
begin
  insert into public.deals (id) values ('40000000-0000-4000-8000-000000000081');
  perform public.reserve_items('40000000-0000-4000-8000-000000000081', array['20000000-0000-4000-8000-000000000004'::uuid]);
  if exists (select 1 from public.circle_want_candidates(circle, 'voyage-multimodal-3.5')
              where item_id = '20000000-0000-4000-8000-000000000004') then
    raise exception 'a reserved Item is a candidate';
  end if;
  perform public.release_deal_items('40000000-0000-4000-8000-000000000081');

  update public.items set willingness = 'not_available' where id = '20000000-0000-4000-8000-000000000003';
  if exists (select 1 from public.circle_want_candidates(circle, 'voyage-multimodal-3.5')
              where item_id = '20000000-0000-4000-8000-000000000003') then
    raise exception 'a not-available Item is a candidate';
  end if;
  update public.items set willingness = 'would_trade' where id = '20000000-0000-4000-8000-000000000003';

  -- Maya's Ask stops prospecting: her offers leave the graph and she stops wanting.
  update public.asks set status = 'offering' where id = '30000000-0000-4000-8000-000000000082';
  if exists (select 1 from public.circle_want_candidates(circle, 'voyage-multimodal-3.5')) then
    raise exception 'an Ask that is not prospecting still counts';
  end if;
  update public.asks set status = 'prospecting' where id = '30000000-0000-4000-8000-000000000082';

  insert into public.blocks (blocker_id, blocked_id)
  values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001');
  if exists (select 1 from public.circle_want_candidates(circle, 'voyage-multimodal-3.5')) then
    raise exception 'blocked people are candidates for each other';
  end if;
  delete from public.blocks where blocker_id = '00000000-0000-4000-8000-000000000002';
end $$;

-- 3. Queueing: offer and want changes on a prospecting Ask queue 1 prospect_ask job.
do $$
declare
  ask constant uuid := '30000000-0000-4000-8000-000000000081';
  waiting int;
begin
  waiting := (select count(*) from public.jobs
               where kind = 'prospect_ask' and status = 'queued' and payload ->> 'ask_id' = ask::text);
  if waiting <> 1 then raise exception 'expected 1 queued job after the offer was set, got %', waiting; end if;
  if (select payload ->> 'user_id' from public.jobs
       where kind = 'prospect_ask' and payload ->> 'ask_id' = ask::text) <> '00000000-0000-4000-8000-000000000001' then
    raise exception 'job payload is missing the user';
  end if;

  -- More changes while 1 is waiting don't pile up.
  update public.asks set target = '{"kind": "category", "name": "LEGO space"}' where id = ask;
  delete from public.offer_sets where ask_id = ask;
  if (select count(*) from public.jobs
       where kind = 'prospect_ask' and status = 'queued' and payload ->> 'ask_id' = ask::text) <> 1 then
    raise exception 'jobs piled up';
  end if;

  -- Once it has run, the next change queues again; edits that don't touch the want don't.
  update public.jobs set status = 'done' where kind = 'prospect_ask' and payload ->> 'ask_id' = ask::text;
  update public.asks set raw_text = 'a LEGO space set', autonomy = 'likely_yes' where id = ask;
  if exists (select 1 from public.jobs
              where kind = 'prospect_ask' and status = 'queued' and payload ->> 'ask_id' = ask::text) then
    raise exception 'a wording change should not prospect';
  end if;
  update public.asks set cash_ceiling_cents = 3000 where id = ask;
  if not exists (select 1 from public.jobs
                  where kind = 'prospect_ask' and status = 'queued' and payload ->> 'ask_id' = ask::text) then
    raise exception 'a new cash ceiling should prospect';
  end if;

  -- An Ask that isn't prospecting never queues.
  update public.jobs set status = 'done' where kind = 'prospect_ask';
  update public.asks set status = 'offering' where id = ask;
  insert into public.offer_sets (ask_id, item_id) values (ask, '20000000-0000-4000-8000-000000000002');
  if exists (select 1 from public.jobs where kind = 'prospect_ask' and status = 'queued') then
    raise exception 'an offering Ask queued a prospect';
  end if;
  -- Moving into prospecting does.
  update public.asks set status = 'prospecting' where id = ask;
  if not exists (select 1 from public.jobs
                  where kind = 'prospect_ask' and status = 'queued' and payload ->> 'ask_id' = ask::text) then
    raise exception 'starting to prospect should queue a job';
  end if;
end $$;

-- 4. Only the server can read candidates or queue jobs, and nobody can read Ask embeddings.
do $$
begin
  if has_function_privilege('authenticated', 'public.circle_want_candidates(uuid, text, int)', 'execute')
     or has_function_privilege('anon', 'public.circle_want_candidates(uuid, text, int)', 'execute')
     or has_function_privilege('authenticated', 'public.enqueue_prospect_ask(uuid, uuid)', 'execute') then
    raise exception 'Prospector functions must be service role only';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.ask_embeddings'::regclass) then
    raise exception 'ask_embeddings needs row-level security';
  end if;
  if exists (select 1 from pg_policies where tablename = 'ask_embeddings') then
    raise exception 'ask_embeddings should have no policies';
  end if;
end $$;

select 'prospector tests passed';
rollback;

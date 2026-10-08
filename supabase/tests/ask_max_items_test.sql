-- Asks that take several Items: patch_ask sets max_items, out-of-range values are refused,
-- and a change on a prospecting Ask queues a re-match.
-- Runs inside a transaction that is rolled back, so later test files see the seed as is.
\set ON_ERROR_STOP on

begin;

insert into public.asks (id, user_id, raw_text, status) values
  ('30000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000001', 'Switch games', 'prospecting');

do $$
declare
  jordan constant uuid := '00000000-0000-4000-8000-000000000001';
  ask constant uuid := '30000000-0000-4000-8000-0000000000e1';
begin
  if (select max_items from public.asks where id = ask) <> 1 then
    raise exception 'an Ask takes 1 Item by default';
  end if;

  delete from public.jobs where kind = 'prospect_ask';
  if public.patch_ask(jordan, ask, '{"max_items": 3}')->>'result' <> 'ok' then
    raise exception 'patch failed';
  end if;
  if (select max_items from public.asks where id = ask) <> 3 then
    raise exception 'max_items not saved';
  end if;
  if (select count(*) from public.jobs where kind = 'prospect_ask' and payload->>'ask_id' = ask::text) <> 1 then
    raise exception 'taking more Items should queue a re-match';
  end if;

  begin
    perform public.patch_ask(jordan, ask, '{"max_items": 6}');
    raise exception 'max_items 6 was accepted';
  exception when check_violation then null;
  end;
end $$;

select 'ask max items tests passed';
rollback;

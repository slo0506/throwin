-- Spend caps: model_spend_cents sums agent_runs by window, person and GM or background.
-- Runs inside a transaction that is rolled back, so later test files see the seed as is.
\set ON_ERROR_STOP on

begin;

-- security_test deletes the second seed user, so this test brings its own.
insert into auth.users (id, email, raw_user_meta_data)
values ('00000000-0000-4000-8000-0000000000b5', 'spend@example.com', '{"first_name": "Sam"}');

-- 1. Sums only the window, and splits GM chat from the background agents.
do $$
declare
  day_ago constant timestamptz := now() - interval '24 hours';
  alice constant uuid := '00000000-0000-4000-8000-000000000001';
  sam constant uuid := '00000000-0000-4000-8000-0000000000b5';
  everything constant numeric := public.model_spend_cents(day_ago);
  gm constant numeric := public.model_spend_cents(day_ago, null, true);
  background constant numeric := public.model_spend_cents(day_ago, null, false);
  alice_gm constant numeric := public.model_spend_cents(day_ago, alice, true);
begin
  insert into public.agent_runs (agent, trigger, user_id, cost_cents, created_at) values
    ('gm', 'turn', alice, 1.5, now() - interval '1 hour'),
    ('gm', 'resolve_target', sam, 8, now() - interval '2 hours'),
    ('appraiser.identify', 'capture', alice, 2.25, now() - interval '3 hours'),
    ('prospector.review', 'drop', null, 4, now() - interval '30 minutes'),
    -- Older than a day: never counted.
    ('gm', 'turn', alice, 50, now() - interval '25 hours');

  if public.model_spend_cents(day_ago) - everything <> 15.75 then
    raise exception 'everything: expected +15.75, got +%', public.model_spend_cents(day_ago) - everything;
  end if;
  if public.model_spend_cents(day_ago, null, true) - gm <> 9.5 then
    raise exception 'GM chat: expected +9.5';
  end if;
  if public.model_spend_cents(day_ago, null, false) - background <> 6.25 then
    raise exception 'background: expected +6.25';
  end if;
  if public.model_spend_cents(day_ago, alice, true) - alice_gm <> 1.5 then
    raise exception 'Alice''s GM chat: expected +1.5';
  end if;
  if public.model_spend_cents(now() + interval '1 hour') <> 0 then
    raise exception 'an empty window should be 0';
  end if;
end $$;

rollback;

-- 2. Clients can't read anyone's spend.
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$
begin
  perform public.model_spend_cents(now() - interval '1 day');
  raise exception 'authenticated role could execute model_spend_cents';
exception when insufficient_privilege then null;
end $$;
rollback;

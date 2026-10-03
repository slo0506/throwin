-- Joining Circles through invite codes (Milestone 3).
-- Runs inside a transaction that is rolled back, so later test files see the seed as is.
-- From seed.sql: the Thursday Lego Circle ...0001, owned by Jordan ...0001 with Maya ...0002
-- as a member, and the invite THURSDAY-LEGO (25 uses, 14 days).
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000071', 'sam@example.com', '{"first_name": "Sam"}'),
  ('00000000-0000-4000-8000-000000000072', 'riley@example.com', '{"first_name": "Riley"}'),
  ('00000000-0000-4000-8000-000000000073', 'casey@example.com', '{"first_name": "Casey"}');

insert into public.invites (code, circle_id, created_by, max_uses, expires_at) values
  ('LAST-SEAT', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 1, now() + interval '1 day'),
  ('TOO-LATE', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 5, now() - interval '1 minute');

do $$
declare
  circle constant uuid := '10000000-0000-4000-8000-000000000001';
  maya constant uuid := '00000000-0000-4000-8000-000000000002';
  sam constant uuid := '00000000-0000-4000-8000-000000000071';
  riley constant uuid := '00000000-0000-4000-8000-000000000072';
  casey constant uuid := '00000000-0000-4000-8000-000000000073';
  uses_before int := (select uses from public.invites where code = 'THURSDAY-LEGO');
  r jsonb;
begin
  -- 1. A new person joins as a member, and the invite counts 1 use.
  r := public.accept_invite(sam, 'THURSDAY-LEGO');
  if r->>'result' <> 'ok' or (r->>'circle_id')::uuid <> circle then
    raise exception 'join failed: %', r;
  end if;
  if (select role from public.circle_members where circle_id = circle and user_id = sam) <> 'member' then
    raise exception 'Sam should be a member';
  end if;
  if (select uses from public.invites where code = 'THURSDAY-LEGO') <> uses_before + 1 then
    raise exception 'uses should go up by 1';
  end if;

  -- 2. Redeeming again, or as an existing member, changes nothing.
  r := public.accept_invite(sam, 'THURSDAY-LEGO');
  if r->>'result' <> 'already_member' then raise exception 'rejoin: %', r; end if;
  r := public.accept_invite(maya, 'THURSDAY-LEGO');
  if r->>'result' <> 'already_member' then raise exception 'member join: %', r; end if;
  if (select uses from public.invites where code = 'THURSDAY-LEGO') <> uses_before + 1 then
    raise exception 'a repeat should not count a use';
  end if;

  -- 3. Unknown, expired and full codes are refused and add nobody.
  r := public.accept_invite(riley, 'NO-SUCH-CODE');
  if r->>'result' <> 'not_found' then raise exception 'unknown code: %', r; end if;
  r := public.accept_invite(riley, 'TOO-LATE');
  if r->>'result' <> 'expired' then raise exception 'expired code: %', r; end if;
  r := public.accept_invite(riley, 'LAST-SEAT');
  if r->>'result' <> 'ok' then raise exception 'last seat: %', r; end if;
  r := public.accept_invite(casey, 'LAST-SEAT');
  if r->>'result' <> 'full' then raise exception 'full code: %', r; end if;
  if exists (select 1 from public.circle_members where user_id = casey) then
    raise exception 'Casey should not have joined';
  end if;

  -- 4. A paused Circle's codes stop working.
  update public.circles set status = 'paused' where id = circle;
  r := public.accept_invite(casey, 'THURSDAY-LEGO');
  if r->>'result' <> 'not_found' then raise exception 'paused Circle: %', r; end if;
  update public.circles set status = 'active' where id = circle;
end $$;

-- 5. Only the server can redeem invites.
do $$
begin
  if has_function_privilege('authenticated', 'public.accept_invite(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.accept_invite(uuid, text)', 'execute') then
    raise exception 'accept_invite must be service role only';
  end if;
end $$;

select 'circles tests passed';
rollback;

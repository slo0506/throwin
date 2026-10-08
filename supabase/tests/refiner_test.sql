-- Refiner: readiness, photo scores, questions and answers.
-- Runs inside a transaction that is rolled back, so later test files see the seed as is.
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data)
values ('00000000-0000-4000-8000-000000000005', 'sam@example.com', '{"first_name": "Sam"}');

insert into public.items (id, owner_id, status, title, category, identity_conf, value_low_cents, value_mid_cents, value_high_cents)
values
  -- Sneaker: unsure identity, wide range.
  ('20000000-0000-4000-8000-000000000051', '00000000-0000-4000-8000-000000000005', 'on_shelf', 'White high-top sneakers', 'sneakers', 0.5, 4000, 6500, 9000),
  -- Console: sure identity, narrow range.
  ('20000000-0000-4000-8000-000000000052', '00000000-0000-4000-8000-000000000005', 'on_shelf', 'PlayStation 5 Slim', 'electronics', 0.93, 30000, 34000, 38000);
insert into public.item_media (item_id, storage_path, position)
values ('20000000-0000-4000-8000-000000000051', '00000000-0000-4000-8000-000000000005/c/crops/0.jpg', 0);

-- 1. Readiness is computed on every write, from the server's columns.
do $$
declare
  sneaker constant uuid := '20000000-0000-4000-8000-000000000051';
  console constant uuid := '20000000-0000-4000-8000-000000000052';
begin
  if (select readiness from public.items where id = sneaker) <> 'logged' then
    raise exception 'unsure sneaker should be logged';
  end if;
  if (select readiness from public.items where id = console) <> 'identified' then
    raise exception 'sure console with a narrow range should be identified';
  end if;
  update public.items set photo_score = 80 where id = console;
  if (select readiness from public.items where id = console) <> 'showcase' then
    raise exception 'photo score 80 with no missing angles should be showcase';
  end if;
  update public.items set missing_angles = array['Ports'] where id = console;
  if (select readiness from public.items where id = console) <> 'identified' then
    raise exception 'missing angles should hold showcase back';
  end if;
  update public.items set value_high_cents = 48001, value_mid_cents = 34000 where id = console;
  if (select readiness from public.items where id = console) <> 'logged' then
    raise exception 'a wide range should be logged';
  end if;
  update public.items set identity_confirmed = true, value_high_cents = 6400, value_mid_cents = 5000, value_low_cents = 4000
   where id = sneaker;
  if (select readiness from public.items where id = sneaker) <> 'identified' then
    raise exception 'owner confirmation and a 1.6x range should be identified';
  end if;
  -- Put the sneaker back.
  update public.items set identity_confirmed = false, value_low_cents = 4000, value_mid_cents = 6500, value_high_cents = 9000
   where id = sneaker;
  if exists (select 1 from public.items where status = 'needs_photos') then
    raise exception 'needs_photos rows remain';
  end if;
end $$;

-- 2. Photo issues only take known codes.
do $$
begin
  update public.items set photo_issues = array['ugly'] where id = '20000000-0000-4000-8000-000000000051';
  raise exception 'unknown photo issue accepted';
exception when check_violation then null;
end $$;

-- 3. Question shapes.
insert into public.item_questions (id, item_id, kind, prompt, options, driver, impact)
values
  ('60000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000051', 'yes_no', 'Is this Nike?', '["Yes", "No", "Not sure"]', 'brand', 0.6),
  ('60000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000051', 'picker', 'What size?', '["9", "9.5", "10", "10.5"]', 'size', 0.3),
  ('60000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000051', 'photo', 'Photo of the size tag', '[]', 'model', 0.5),
  ('60000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000051', 'text', 'Anything written on the tag?', '[]', 'colorway', 0.2);
do $$
begin
  begin
    insert into public.item_questions (item_id, kind, prompt, options, driver)
    values ('20000000-0000-4000-8000-000000000052', 'yes_no', 'Is it a Slim?', '["Yes", "No"]', 'revision');
    raise exception 'yes_no without Not sure accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.item_questions (item_id, kind, prompt, options, driver)
    values ('20000000-0000-4000-8000-000000000052', 'choice', 'Which one?', '["Slim", "Pro"]', 'model');
    raise exception 'choice without Not sure accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.item_questions (item_id, kind, prompt, options, driver)
    values ('20000000-0000-4000-8000-000000000051', 'yes_no', 'Is this Adidas?', '["Yes", "No", "Not sure"]', 'brand');
    raise exception '2 open questions for 1 driver accepted';
  exception when unique_violation then null;
  end;
end $$;

-- 4. Clients read their own questions and nothing else, and never write.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000005';
do $$
begin
  if (select count(*) from public.item_questions) <> 4 then
    raise exception 'owner should see 4 questions, saw %', (select count(*) from public.item_questions);
  end if;
  begin
    update public.item_questions set status = 'answered', answered_at = now();
    raise exception 'clients can update questions';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.item_questions (item_id, kind, prompt, driver)
    values ('20000000-0000-4000-8000-000000000051', 'text', 'Hi', 'x');
    raise exception 'clients can insert questions';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.answer_item_question('00000000-0000-4000-8000-000000000005', '60000000-0000-4000-8000-000000000001', 'Yes', false);
    raise exception 'clients can call answer_item_question';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.enqueue_refine_item('20000000-0000-4000-8000-000000000051', '00000000-0000-4000-8000-000000000005', 'x');
    raise exception 'clients can call enqueue_refine_item';
  exception when insufficient_privilege then null;
  end;
  -- Owners can still rename, but never set server-only columns or readiness.
  update public.items
     set title = 'My sneakers', photo_score = 100, identity_confirmed = true, readiness = 'showcase',
         description = 'Genuine!', missing_angles = '{}'
   where id = '20000000-0000-4000-8000-000000000051';
end $$;
reset role;
do $$
declare
  v public.items;
begin
  select * into v from public.items where id = '20000000-0000-4000-8000-000000000051';
  if v.title <> 'My sneakers' then raise exception 'owner rename lost'; end if;
  if v.photo_score is not null or v.identity_confirmed or v.description is not null or v.readiness <> 'logged' then
    raise exception 'a client set server-only columns';
  end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$
begin
  if exists (select 1 from public.item_questions) then
    raise exception 'RLS leak: another user''s questions are visible';
  end if;
end $$;
reset role;

-- 5. Answering.
do $$
declare
  sam constant uuid := '00000000-0000-4000-8000-000000000005';
  sneaker constant uuid := '20000000-0000-4000-8000-000000000051';
  r jsonb;
  jobs_before int := (select count(*) from public.jobs where kind = 'refine_item');
begin
  -- Someone else's question: not found.
  r := public.answer_item_question('00000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'Yes', false);
  if r ->> 'result' <> 'not_found' then raise exception 'other user: %', r; end if;
  -- Not an option.
  r := public.answer_item_question(sam, '60000000-0000-4000-8000-000000000001', 'Maybe', false);
  if r ->> 'result' <> 'invalid_answer' then raise exception 'bad option: %', r; end if;
  -- Text over 200 characters.
  r := public.answer_item_question(sam, '60000000-0000-4000-8000-000000000004', repeat('x', 201), false);
  if r ->> 'result' <> 'invalid_answer' then raise exception 'long text: %', r; end if;
  -- Photo questions are answered with media.
  r := public.answer_item_question(sam, '60000000-0000-4000-8000-000000000003', 'here', false);
  if r ->> 'result' <> 'use_media_upload' then raise exception 'photo: %', r; end if;
  if (select appraising from public.items where id = sneaker) then
    raise exception 'refused answers flagged the item';
  end if;

  r := public.answer_item_question(sam, '60000000-0000-4000-8000-000000000001', 'Yes', false);
  if r ->> 'result' <> 'ok' or (r ->> 'item_id')::uuid <> sneaker then raise exception 'answer: %', r; end if;
  if (select status from public.item_questions where id = '60000000-0000-4000-8000-000000000001') <> 'answered'
     or (select answer from public.item_questions where id = '60000000-0000-4000-8000-000000000001') <> '{"value": "Yes"}'::jsonb then
    raise exception 'answer not recorded';
  end if;
  if not (select appraising from public.items where id = sneaker) then raise exception 'item not appraising'; end if;
  if (select count(*) from public.jobs where kind = 'refine_item') <> jobs_before + 1 then
    raise exception 'refine_item not enqueued';
  end if;
  if not exists (select 1 from public.jobs where kind = 'refine_item'
                  and payload = jsonb_build_object('item_id', sneaker, 'user_id', sam, 'reason', 'answer')) then
    raise exception 'refine_item payload is wrong';
  end if;

  -- Again: already answered.
  r := public.answer_item_question(sam, '60000000-0000-4000-8000-000000000001', 'No', false);
  if r ->> 'result' <> 'already_answered' then raise exception 'twice: %', r; end if;

  -- A skip while a pass is already queued: recorded, no second job.
  r := public.answer_item_question(sam, '60000000-0000-4000-8000-000000000002', null, true);
  if r ->> 'result' <> 'ok' then raise exception 'skip: %', r; end if;
  if (select (status, skip_count, answer) from public.item_questions where id = '60000000-0000-4000-8000-000000000002')
     is distinct from ('skipped'::public.item_question_status, 1::smallint, null::jsonb) then
    raise exception 'skip not recorded';
  end if;
  if (select count(*) from public.jobs where kind = 'refine_item') <> jobs_before + 1 then
    raise exception 'a queued pass was duplicated';
  end if;
end $$;

-- 6. Follow-up photos answer open photo questions.
do $$
begin
  update public.items set appraising = false where id = '20000000-0000-4000-8000-000000000051';
  perform public.submit_item_media('00000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000051',
    '[{"path": "00000000-0000-4000-8000-000000000005/items/20000000-0000-4000-8000-000000000051/a.jpg"}]'::jsonb);
  if (select (status, answer) from public.item_questions where id = '60000000-0000-4000-8000-000000000003')
     is distinct from ('answered'::public.item_question_status, '{"media": true}'::jsonb) then
    raise exception 'photo question not answered by the upload';
  end if;
  if (select status from public.item_questions where id = '60000000-0000-4000-8000-000000000004') <> 'open' then
    raise exception 'the upload closed a text question';
  end if;
end $$;

-- 7. An Item out for approval in a Deal takes no answers; a staged Deal, which waits for
--    exactly these answers, lets them through.
insert into public.deals (id, status) values ('50000000-0000-4000-8000-000000000051', 'pending_approvals');
do $$
declare
  r jsonb;
begin
  update public.items set status = 'reserved', reserved_by_deal_id = '50000000-0000-4000-8000-000000000051'
   where id = '20000000-0000-4000-8000-000000000051';
  r := public.answer_item_question('00000000-0000-4000-8000-000000000005', '60000000-0000-4000-8000-000000000004', 'Swoosh', false);
  if r ->> 'result' <> 'item_reserved' then raise exception 'reserved: %', r; end if;
  update public.deals set status = 'staged' where id = '50000000-0000-4000-8000-000000000051';
  update public.items set appraising = false where id = '20000000-0000-4000-8000-000000000051';
  r := public.answer_item_question('00000000-0000-4000-8000-000000000005', '60000000-0000-4000-8000-000000000004', 'Swoosh', false);
  if r ->> 'result' <> 'ok' then raise exception 'a staged Deal should take answers: %', r; end if;
  if (select reserved_by_deal_id from public.items where id = '20000000-0000-4000-8000-000000000051')
     <> '50000000-0000-4000-8000-000000000051' then
    raise exception 'the Item must stay held by its Deal';
  end if;
end $$;

rollback;

select 'refiner tests passed' as result;

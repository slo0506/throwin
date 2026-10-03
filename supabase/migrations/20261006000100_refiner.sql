-- Milestone 1: Item readiness, photo scores and the Refiner's questions (PRD "Item
-- readiness", "Photo quality and Studio" and "Refinement").

create type public.item_readiness as enum ('logged', 'identified', 'showcase');
create type public.item_question_kind as enum ('yes_no', 'choice', 'picker', 'text', 'photo');
create type public.item_question_status as enum ('open', 'answered', 'skipped');

-- 1. Readiness and photo quality on the Item. All of these are written by the server only.
alter table public.items
  add column readiness public.item_readiness not null default 'logged',
  add column photo_score smallint check (photo_score between 0 and 100),
  add column photo_issues text[] not null default '{}' check (
    photo_issues <@ array['too_small', 'blurry', 'dark', 'cut_off', 'cluttered_background', 'missing_angles']::text[]
  ),
  add column missing_angles text[] not null default '{}' check (cardinality(missing_angles) <= 8),
  add column description text check (char_length(description) <= 600),
  -- The owner pinned the product: a question answer that named it, or PATCH confirm.
  add column identity_confirmed boolean not null default false,
  -- Last SKU research pass. At most 1 a day per Item unless the owner adds information.
  add column researched_at timestamptz;

create index items_readiness_idx on public.items (owner_id, readiness) where status <> 'removed';

-- Mirrors computeReadiness in packages/shared/src/readiness.ts. Change both together.
create or replace function public.compute_item_readiness(
  p_identity_conf real,
  p_identity_confirmed boolean,
  p_value_low_cents int,
  p_value_high_cents int,
  p_photo_score smallint,
  p_missing_angles text[]
)
returns public.item_readiness
language sql
immutable
set search_path = ''
as $$
  select case
    when not (coalesce(p_identity_confirmed, false) or coalesce(p_identity_conf, 0) >= 0.85)
      or p_value_low_cents is null
      or p_value_high_cents is null
      or p_value_high_cents > 1.6 * p_value_low_cents
      then 'logged'::public.item_readiness
    when coalesce(p_photo_score, 0) >= 75 and coalesce(cardinality(p_missing_angles), 0) = 0
      then 'showcase'::public.item_readiness
    else 'identified'::public.item_readiness
  end;
$$;

-- Readiness is never set by a client, and neither is anything it is computed from that
-- only the server knows. Owners can still edit their own rows through RLS (title,
-- willingness), so a client write keeps the server's values for these columns, and every
-- write recomputes readiness.
create or replace function public.items_readiness()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.photo_score := null;
      new.photo_issues := '{}';
      new.missing_angles := '{}';
      new.description := null;
      new.identity_confirmed := false;
      new.researched_at := null;
    else
      new.photo_score := old.photo_score;
      new.photo_issues := old.photo_issues;
      new.missing_angles := old.missing_angles;
      new.description := old.description;
      new.identity_confirmed := old.identity_confirmed;
      new.researched_at := old.researched_at;
    end if;
  end if;
  new.readiness := public.compute_item_readiness(
    new.identity_conf, new.identity_confirmed, new.value_low_cents, new.value_high_cents,
    new.photo_score, new.missing_angles
  );
  return new;
end;
$$;

create trigger items_readiness before insert or update on public.items
  for each row execute function public.items_readiness();

revoke execute on function public.items_readiness() from public, anon, authenticated;

-- 2. needs_photos is retired: readiness carries what an Item still needs. The enum value
--    stays so older rows and clients still parse, but nothing writes it any more.
update public.items set status = 'on_shelf' where status = 'needs_photos';
-- Backfill readiness for every existing row (the trigger computes it).
update public.items set readiness = 'logged';

-- 3. The Refiner's questions. Owner-only by RLS; all writes go through the worker (service
--    role) or the security definer functions below.
create table public.item_questions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items (id) on delete cascade,
  kind public.item_question_kind not null,
  prompt text not null check (char_length(prompt) between 1 and 200),
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  -- The value driver the answer resolves, e.g. "brand", "size", "storage".
  driver text not null check (char_length(driver) between 1 and 60),
  -- How much the answer would narrow the range, 0 to 1. Ranked by impact over effort.
  impact real not null default 0.5 check (impact between 0 and 1),
  status public.item_question_status not null default 'open',
  skip_count smallint not null default 0 check (skip_count >= 0),
  -- {"value": "Yes"} for an answer, {"media": true} when photos answered it. Null if skipped.
  answer jsonb,
  -- When the Refiner folded the answer into the Item. Null while it still has to.
  folded_at timestamptz,
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  check (
    case kind
      when 'yes_no' then options = '["Yes", "No", "Not sure"]'::jsonb
      when 'choice' then jsonb_array_length(options) between 3 and 5 and options ? 'Not sure'
      when 'picker' then jsonb_array_length(options) between 1 and 30
      else options = '[]'::jsonb
    end
  ),
  check ((status = 'open') = (answered_at is null))
);
-- Tune up reads open questions per Item (and Items by owner through items_owner_idx).
create index item_questions_open_idx on public.item_questions (item_id, created_at) where status = 'open';
create index item_questions_item_idx on public.item_questions (item_id, status);
-- 1 open question per value driver per Item.
create unique index item_questions_open_driver_idx on public.item_questions (item_id, driver) where status = 'open';

alter table public.item_questions enable row level security;
create policy item_questions_owner_select on public.item_questions
  for select to authenticated
  using (exists (select 1 from public.items i where i.id = item_id and i.owner_id = (select auth.uid())));
revoke insert, update, delete, truncate on table public.item_questions from public, anon, authenticated;
revoke select on table public.item_questions from public, anon;

-- 4. Queue a Refiner pass. Skips when 1 is already waiting for this Item (a running one
--    does not count, so answers given while it runs still get folded).
create or replace function public.enqueue_refine_item(p_item_id uuid, p_user_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.jobs
     where kind = 'refine_item' and status = 'queued' and payload ->> 'item_id' = p_item_id::text
  ) then
    return false;
  end if;
  insert into public.jobs (kind, payload)
  values ('refine_item', jsonb_build_object('item_id', p_item_id, 'user_id', p_user_id, 'reason', p_reason));
  return true;
end;
$$;

revoke execute on function public.enqueue_refine_item(uuid, uuid, text) from public, anon, authenticated;

-- 5. Answer or skip a question. Called by the API with the service role after it checks
--    auth. Returns {"result": ...}: ok, not_found, already_answered, item_reserved,
--    use_media_upload or invalid_answer, plus item_id when the question was found.
create or replace function public.answer_item_question(p_user_id uuid, p_question_id uuid, p_answer text, p_skip boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_question public.item_questions;
  v_item public.items;
  v_answer text := btrim(coalesce(p_answer, ''));
begin
  select q.* into v_question
    from public.item_questions q
    join public.items i on i.id = q.item_id
   where q.id = p_question_id and i.owner_id = p_user_id and i.status <> 'removed'
   for update of q;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  select * into v_item from public.items where id = v_question.item_id for update;

  if v_question.status <> 'open' then
    return jsonb_build_object('result', 'already_answered', 'item_id', v_item.id);
  end if;
  if v_item.reserved_by_deal_id is not null or v_item.status in ('reserved', 'traded') then
    return jsonb_build_object('result', 'item_reserved', 'item_id', v_item.id);
  end if;

  if not coalesce(p_skip, false) then
    if v_question.kind = 'photo' then
      return jsonb_build_object('result', 'use_media_upload', 'item_id', v_item.id);
    end if;
    if (v_question.kind in ('yes_no', 'choice', 'picker') and not (v_question.options ? v_answer))
       or (v_question.kind = 'text' and char_length(v_answer) not between 1 and 200) then
      return jsonb_build_object('result', 'invalid_answer', 'item_id', v_item.id);
    end if;
    update public.item_questions
       set status = 'answered', answer = jsonb_build_object('value', v_answer), answered_at = now()
     where id = p_question_id;
  else
    update public.item_questions
       set status = 'skipped', skip_count = skip_count + 1, answered_at = now()
     where id = p_question_id;
  end if;

  update public.items set appraising = true where id = v_item.id;
  perform public.enqueue_refine_item(v_item.id, p_user_id, 'answer');
  return jsonb_build_object('result', 'ok', 'item_id', v_item.id);
end;
$$;

revoke execute on function public.answer_item_question(uuid, uuid, text, boolean) from public, anon, authenticated;

-- 6. Follow-up photos also answer the Item's open photo questions. Same as Appraiser v2,
--    plus that update. The reappraisal folds the photos in and then hands off to the Refiner.
create or replace function public.submit_item_media(p_user_id uuid, p_item_id uuid, p_media jsonb)
returns public.items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_prefix text := p_user_id::text || '/items/' || p_item_id::text || '/';
  v_count int := coalesce(jsonb_array_length(p_media), 0);
  v_next int;
begin
  select * into v_item from public.items
   where id = p_item_id and owner_id = p_user_id and status <> 'removed'
   for update;
  if not found then
    return null;
  end if;
  if v_item.reserved_by_deal_id is not null or v_item.status in ('reserved', 'traded') or v_item.appraising then
    raise exception 'item is reserved or already appraising' using errcode = '55006';
  end if;

  if v_count < 1 or v_count > 5 then
    raise exception 'expected 1 to 5 photos, got %', v_count using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_media) m
     where coalesce(m ->> 'path', '') = ''
        or left(m ->> 'path', length(v_prefix)) <> v_prefix
        or position('..' in m ->> 'path') > 0
  ) then
    raise exception 'media must come from this item''s uploads' using errcode = '22023';
  end if;

  select coalesce(max(position), -1) + 1 into v_next from public.item_media where item_id = p_item_id;

  insert into public.item_media (item_id, storage_path, kind, width, height, sharpness, position)
  select p_item_id,
         m ->> 'path',
         'photo',
         (m ->> 'width')::int,
         (m ->> 'height')::int,
         (m ->> 'sharpness')::real,
         v_next + (t.ordinality - 1)::int
    from jsonb_array_elements(p_media) with ordinality as t(m, ordinality);

  -- The reappraisal reads the photos themselves, so these answers are already folded.
  update public.item_questions
     set status = 'answered', answer = jsonb_build_object('media', true), answered_at = now(), folded_at = now()
   where item_id = p_item_id and kind = 'photo' and status = 'open';

  update public.items set appraising = true where id = p_item_id
  returning * into v_item;

  insert into public.jobs (kind, payload)
  values ('reappraise_item', jsonb_build_object('item_id', p_item_id, 'user_id', p_user_id));

  return v_item;
end;
$$;

revoke execute on function public.submit_item_media(uuid, uuid, jsonb) from public, anon, authenticated;

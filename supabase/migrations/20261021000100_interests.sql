-- "Someone wants your Item" (docs/specs/agents-and-trading.md; PRD "When someone else's Ask
-- matches your Shelf"). The matcher only sees Items offered for an Ask, so an Item that sits
-- on a Shelf, offered for nothing, can't trade even when a Circle-mate asks for exactly it.
-- When the Prospector finds 1, it tells the owner: "Maya is looking for your Zelda." The
-- owner sees what Maya offers for that Ask and picks 1 thing they'd take (an Ask for it is
-- made, with the wanted Item offered, and matching runs), or says no (the Item stays away
-- from that Ask). Limits: 2 a day per Ask, 3 a day per owner, each open for 48 hours.
-- Server only.

create type public.interest_status as enum ('pending', 'accepted', 'declined', 'expired');

create table public.interests (
  id uuid primary key default gen_random_uuid(),
  -- The Ask that wants the Item, and its owner.
  ask_id uuid not null references public.asks (id) on delete cascade,
  wanter_id uuid not null references public.users (id) on delete cascade,
  -- The Item, and its owner, who answers.
  item_id uuid not null references public.items (id) on delete cascade,
  owner_id uuid not null references public.users (id) on delete cascade,
  status public.interest_status not null default 'pending',
  -- On yes: the wanter's Item the owner picked, and the Ask made for it.
  want_item_id uuid references public.items (id) on delete set null,
  answer_ask_id uuid references public.asks (id) on delete set null,
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  expires_at timestamptz not null default now() + interval '48 hours',
  unique (ask_id, item_id)
);
create index interests_owner_idx on public.interests (owner_id, created_at desc);
create index interests_ask_idx on public.interests (ask_id, created_at desc);
alter table public.interests enable row level security;

-- Items on Circle-mates' Shelves that an Ask might want but that their owners offer for
-- nothing open, nearest first. Same rules as circle_want_candidates otherwise: free to trade,
-- priced, not excluded from the Ask, nobody blocked, and not asked about before.
create or replace function public.shelf_interest_candidates(
  p_ask_id uuid,
  p_model text,
  p_limit int default 5
)
returns table (
  item_id uuid,
  owner_id uuid,
  similarity real,
  title text,
  category text,
  brand text,
  model text,
  value_mid_cents int
)
language sql
stable
security definer
set search_path = ''
as $$
  with ask as (
    select a.id, a.user_id, ae.embedding
      from public.asks a
      join public.ask_embeddings ae on ae.ask_id = a.id and ae.model = p_model
     where a.id = p_ask_id and a.status = 'prospecting'
  ),
  neighbors as (
    select distinct m.user_id
      from public.circle_members m
     where m.circle_id in (
             select circle_id from public.circle_members where user_id = (select user_id from ask)
           )
       and m.user_id <> (select user_id from ask)
  )
  select i.id, i.owner_id,
         (1 - (ie.embedding operator(extensions.<=>) k.embedding))::real,
         i.title, i.category, i.brand, i.model, i.value_mid_cents
    from ask k
    join public.items i on i.owner_id in (select user_id from neighbors)
    join public.item_embeddings ie on ie.item_id = i.id and ie.model = p_model
   where i.status = 'on_shelf'
     and i.reserved_by_deal_id is null
     and i.willingness <> 'not_available'
     and i.value_mid_cents is not null
     and not exists (
       select 1 from public.offer_sets o
         join public.asks oa on oa.id = o.ask_id
        where o.item_id = i.id and oa.status in ('offering', 'prospecting', 'proposed')
     )
     and not exists (select 1 from public.ask_exclusions x where x.ask_id = k.id and x.item_id = i.id)
     and not exists (select 1 from public.interests n where n.ask_id = k.id and n.item_id = i.id)
     and not exists (
       select 1 from public.blocks b
        where (b.blocker_id = k.user_id and b.blocked_id = i.owner_id)
           or (b.blocker_id = i.owner_id and b.blocked_id = k.user_id)
     )
   order by ie.embedding operator(extensions.<=>) k.embedding
   limit p_limit;
$$;

-- Tells the owner, within the limits. Returns { result, interest_id? }:
--   ok       told
--   exists   this Ask and Item were already raised
--   limited  a limit says not now
--   invalid  the Ask isn't prospecting, or the Item isn't free on a Circle-mate's Shelf
create or replace function public.create_interest(p_ask_id uuid, p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ask public.asks%rowtype;
  v_item public.items%rowtype;
  v_id uuid;
begin
  select a.* into v_ask from public.asks a where a.id = p_ask_id for update;
  select i.* into v_item from public.items i where i.id = p_item_id;
  if v_ask.id is null or v_ask.status <> 'prospecting' or v_item.id is null
     or v_item.owner_id = v_ask.user_id or v_item.status <> 'on_shelf'
     or not exists (
       select 1 from public.circle_members a
         join public.circle_members b on b.circle_id = a.circle_id
        where a.user_id = v_ask.user_id and b.user_id = v_item.owner_id
     ) then
    return jsonb_build_object('result', 'invalid');
  end if;
  if exists (select 1 from public.interests where ask_id = p_ask_id and item_id = p_item_id) then
    return jsonb_build_object('result', 'exists');
  end if;
  if (select count(*) from public.interests
       where ask_id = p_ask_id and created_at > now() - interval '24 hours') >= 2
     or (select count(*) from public.interests
          where owner_id = v_item.owner_id and created_at > now() - interval '24 hours') >= 3 then
    return jsonb_build_object('result', 'limited');
  end if;

  insert into public.interests (ask_id, wanter_id, item_id, owner_id)
  values (p_ask_id, v_ask.user_id, p_item_id, v_item.owner_id)
  returning id into v_id;
  return jsonb_build_object('result', 'ok', 'interest_id', v_id);
end;
$$;

-- The owner's answer. A want Item (1 the wanter offers for that Ask) means yes: an Ask for
-- it is made, prospecting, with the owner's Item offered, and the new offer starts matching.
-- No want Item means no. Returns { result, ask_id? }: ok, not_found (not theirs), closed
-- (answered, expired, or the wanter's Ask moved on) or invalid (the want Item isn't on
-- offer for that Ask any more, or the owner's Item is no longer free).
create or replace function public.answer_interest(
  p_user_id uuid,
  p_interest_id uuid,
  p_want_item_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_interest public.interests%rowtype;
  v_want public.items%rowtype;
  v_ask_id uuid;
begin
  select n.* into v_interest from public.interests n where n.id = p_interest_id for update;
  if v_interest.id is null or v_interest.owner_id <> p_user_id then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_interest.status <> 'pending' or v_interest.expires_at <= now()
     or not exists (select 1 from public.asks where id = v_interest.ask_id and status = 'prospecting') then
    return jsonb_build_object('result', 'closed');
  end if;

  if p_want_item_id is null then
    update public.interests set status = 'declined', answered_at = now() where id = p_interest_id;
    insert into public.ask_exclusions (ask_id, item_id)
    values (v_interest.ask_id, v_interest.item_id)
    on conflict do nothing;
    return jsonb_build_object('result', 'ok');
  end if;

  select i.* into v_want
    from public.items i
    join public.offer_sets o on o.item_id = i.id and o.ask_id = v_interest.ask_id
   where i.id = p_want_item_id
     and i.owner_id = v_interest.wanter_id
     and i.status = 'on_shelf'
     and i.reserved_by_deal_id is null;
  if v_want.id is null or not exists (
       select 1 from public.items
        where id = v_interest.item_id and owner_id = p_user_id
          and status = 'on_shelf' and reserved_by_deal_id is null
     ) then
    return jsonb_build_object('result', 'invalid');
  end if;

  insert into public.asks (user_id, raw_text, title, target, status)
  values (
    p_user_id,
    left(v_want.title, 500),
    left(v_want.title, 120),
    jsonb_build_object(
      'kind', 'exact',
      'name', left(v_want.title, 120),
      'brand', v_want.brand,
      'model', v_want.model,
      'category', v_want.category,
      'constraints', '[]'::jsonb,
      'anchor', null,
      'image_url', null
    ),
    'prospecting'
  )
  returning id into v_ask_id;
  update public.interests
     set status = 'accepted', answered_at = now(),
         want_item_id = p_want_item_id, answer_ask_id = v_ask_id
   where id = p_interest_id;
  -- Offering the Item queues matching for the new Ask (offer_sets_prospect_on_change).
  insert into public.offer_sets (ask_id, item_id) values (v_ask_id, v_interest.item_id);
  return jsonb_build_object('result', 'ok', 'ask_id', v_ask_id);
end;
$$;

-- Closes what nobody answered within 48 hours. The worker calls it every minute.
create or replace function public.expire_interests()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  update public.interests set status = 'expired'
   where status = 'pending' and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.shelf_interest_candidates(uuid, text, int) from public, anon, authenticated;
revoke execute on function public.create_interest(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.answer_interest(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.expire_interests() from public, anon, authenticated;

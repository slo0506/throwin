-- Milestone 3: what the Prospector needs from the database to build a Circle's want graph.
-- See docs/contracts/m3-matcher.md for how edges become matcher input.

-- 1. Ask embeddings, in the same Voyage space as item_embeddings so an Ask's target can be
--    compared with Item photos and text. source_hash is a hash of the text that was embedded,
--    so the Prospector re-embeds only when the target changes. Server only: no policies.
create table public.ask_embeddings (
  ask_id uuid not null references public.asks (id) on delete cascade,
  model text not null,
  embedding extensions.vector(1024) not null,
  source_hash text not null,
  created_at timestamptz not null default now(),
  primary key (ask_id, model)
);
alter table public.ask_embeddings enable row level security;

-- 2. Edges record which of the giver's Asks offers the Item (the matcher's giver_ask_id).
alter table public.edges
  add column giver_ask_id uuid references public.asks (id) on delete cascade;
create index edges_ask_idx on public.edges (ask_id);

-- 3. Want candidates for a Circle: for every prospecting Ask in it, the Items other members
--    offer for their own prospecting Asks, nearest first by embedding. These are only
--    candidates; the Prospector scores them before any becomes an edge.
--    Only Items that are on the Shelf, unreserved, priced and not marked not available, and
--    never between people who blocked each other. Service role only, so it can return the
--    value and cash fields the matcher needs; nothing here reaches another user.
create or replace function public.circle_want_candidates(
  p_circle_id uuid,
  p_model text,
  p_per_ask int default 25
)
returns table (
  ask_id uuid,
  wanter_id uuid,
  cash_ceiling_cents int,
  item_id uuid,
  giver_id uuid,
  giver_ask_id uuid,
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
  with members as (
    select user_id from public.circle_members where circle_id = p_circle_id
  ),
  open_asks as (
    select a.id, a.user_id, a.cash_ceiling_cents
      from public.asks a
     where a.status = 'prospecting'
       and a.user_id in (select user_id from members)
  ),
  offered as (
    select o.item_id, k.id as giver_ask_id, k.user_id as giver_id
      from public.offer_sets o
      join open_asks k on k.id = o.ask_id
  )
  select w.id, w.user_id, w.cash_ceiling_cents,
         c.item_id, c.giver_id, c.giver_ask_id,
         c.similarity, c.title, c.category, c.brand, c.model, c.value_mid_cents
    from open_asks w
    join public.ask_embeddings ae on ae.ask_id = w.id and ae.model = p_model
    cross join lateral (
      select f.item_id, f.giver_id, f.giver_ask_id,
             (1 - (ie.embedding operator(extensions.<=>) ae.embedding))::real as similarity,
             i.title, i.category, i.brand, i.model, i.value_mid_cents
        from offered f
        join public.items i on i.id = f.item_id
        join public.item_embeddings ie on ie.item_id = i.id and ie.model = p_model
       where f.giver_id <> w.user_id
         and i.status = 'on_shelf'
         and i.reserved_by_deal_id is null
         and i.willingness <> 'not_available'
         and i.value_mid_cents is not null
         and not exists (
           select 1 from public.blocks b
            where (b.blocker_id = w.user_id and b.blocked_id = f.giver_id)
               or (b.blocker_id = f.giver_id and b.blocked_id = w.user_id)
         )
       order by ie.embedding operator(extensions.<=>) ae.embedding
       limit p_per_ask
    ) c;
$$;

revoke execute on function public.circle_want_candidates(uuid, text, int) from public, anon, authenticated;

-- 4. Queue a prospect_ask job, at most 1 waiting per Ask.
create or replace function public.enqueue_prospect_ask(p_ask_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.jobs
     where kind = 'prospect_ask' and status = 'queued' and payload ->> 'ask_id' = p_ask_id::text
  ) then
    return false;
  end if;
  insert into public.jobs (kind, payload)
  values ('prospect_ask', jsonb_build_object('ask_id', p_ask_id, 'user_id', p_user_id));
  return true;
end;
$$;

revoke execute on function public.enqueue_prospect_ask(uuid, uuid) from public, anon, authenticated;

-- 5. Prospect whenever a prospecting Ask's want or offer changes, whichever path changed it
--    (the GM's tools and PATCH /v1/asks both go through patch_ask, but triggers also cover
--    direct writes).
create or replace function public.prospect_on_ask_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'prospecting' and (
       old.status is distinct from 'prospecting'
       or old.target is distinct from new.target
       or old.cash_ceiling_cents is distinct from new.cash_ceiling_cents
     ) then
    perform public.enqueue_prospect_ask(new.id, new.user_id);
  end if;
  return null;
end;
$$;

create trigger asks_prospect_on_change
  after update on public.asks
  for each row execute function public.prospect_on_ask_change();

create or replace function public.prospect_on_offer_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ask_id uuid := coalesce(new.ask_id, old.ask_id);
  v_user_id uuid;
begin
  select user_id into v_user_id from public.asks where id = v_ask_id and status = 'prospecting';
  if found then
    perform public.enqueue_prospect_ask(v_ask_id, v_user_id);
  end if;
  return null;
end;
$$;

create trigger offer_sets_prospect_on_change
  after insert or delete on public.offer_sets
  for each row execute function public.prospect_on_offer_change();

revoke execute on function public.prospect_on_ask_change() from public, anon, authenticated;
revoke execute on function public.prospect_on_offer_change() from public, anon, authenticated;

-- Demand counts (decided Oct 7, 2026; docs/specs/agents-and-trading.md, "Brokering"): what
-- people in the user's Circles are looking for, as counts only. Never who, never their Ask,
-- never their limits. A want shows when at least p_min_askers people share it, so a count
-- can't point at 1 person, or when 1 of the user's own Items could fill it ("someone in
-- your Circles is looking for a Switch game like yours"). Server only.
create or replace function public.circle_demand(
  p_user_id uuid,
  p_min_askers int default 2,
  p_min_similarity real default 0.3,
  p_limit int default 10
)
returns table (label text, category text, askers int, item_ids uuid[])
language sql
stable
security definer
set search_path = ''
as $$
  with neighbors as (
    select distinct m.user_id
      from public.circle_members m
     where m.circle_id in (select circle_id from public.circle_members where user_id = p_user_id)
       and m.user_id <> p_user_id
       and not exists (
         select 1 from public.blocks b
          where (b.blocker_id = p_user_id and b.blocked_id = m.user_id)
             or (b.blocker_id = m.user_id and b.blocked_id = p_user_id)
       )
  ),
  wants as (
    select a.id, a.user_id, lower(btrim(a.target->>'name')) as key,
           btrim(a.target->>'name') as name, a.target->>'category' as category
      from public.asks a
     where a.user_id in (select user_id from neighbors)
       and a.status in ('offering', 'prospecting')
       and coalesce(btrim(a.target->>'name'), '') <> ''
  ),
  -- The user's Items that could fill a want: free to trade, near it in the same embedding
  -- space, and not in a different top-level category.
  fits as (
    select distinct w.key, i.id as item_id
      from wants w
      join public.ask_embeddings ae on ae.ask_id = w.id
      join public.items i
        on i.owner_id = p_user_id
       and i.status = 'on_shelf'
       and i.reserved_by_deal_id is null
       and i.willingness <> 'not_available'
       and (w.category is null or i.category is null
            or split_part(lower(w.category), '/', 1) = split_part(lower(i.category), '/', 1))
      join public.item_embeddings ie on ie.item_id = i.id and ie.model = ae.model
     where 1 - (ie.embedding operator(extensions.<=>) ae.embedding) >= p_min_similarity
  ),
  grouped as (
    select w.key, min(w.name) as label, min(w.category) as category,
           count(distinct w.user_id)::int as askers
      from wants w
     group by w.key
  )
  select g.label, g.category, g.askers,
         coalesce(array(select f.item_id from fits f where f.key = g.key order by f.item_id), '{}')
    from grouped g
   where g.askers >= p_min_askers or exists (select 1 from fits f where f.key = g.key)
   order by exists (select 1 from fits f where f.key = g.key) desc, g.askers desc, g.label
   limit p_limit;
$$;

revoke execute on function public.circle_demand(uuid, int, real, int) from public, anon, authenticated;

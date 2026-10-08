-- Bundles: X Items for Y, in Loops of 2 to 4 (decided Oct 7, 2026;
-- docs/specs/agents-and-trading.md, docs/contracts/m3-matcher.md). A Deal can hand a person
-- several Items: more for an Ask that takes several, or Items for another of their Asks.

-- How many Items an Ask takes: 1, or several ("2 or 3 board games").
alter table public.asks
  add column max_items int not null default 1 check (max_items between 1 and 5);

-- The giver's Ask whose offer set held the Item: the Ask the Loop fills for the giver.
-- Null on legs staged before bundles.
alter table public.deal_legs
  add column giver_ask_id uuid references public.asks (id) on delete set null;

-- As in 20261012000100_deal_decisions.sql, plus each wanting Ask's max_items. The return
-- type changes, so the function is dropped first.
drop function public.circle_want_candidates(uuid, text, int);
create function public.circle_want_candidates(
  p_circle_id uuid,
  p_model text,
  p_per_ask int default 25
)
returns table (
  ask_id uuid,
  wanter_id uuid,
  cash_ceiling_cents int,
  max_items int,
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
    select a.id, a.user_id, a.cash_ceiling_cents, a.max_items
      from public.asks a
     where a.status = 'prospecting'
       and a.user_id in (select user_id from members)
  ),
  offered as (
    select o.item_id, k.id as giver_ask_id, k.user_id as giver_id
      from public.offer_sets o
      join open_asks k on k.id = o.ask_id
  )
  select w.id, w.user_id, w.cash_ceiling_cents, w.max_items,
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
           select 1 from public.ask_exclusions x where x.ask_id = w.id and x.item_id = f.item_id
         )
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

-- As in 20261013000100_deal_whys.sql, with bundles. A Deal is a Loop of 2 to 4 people:
-- each gets and gives at least 1 Item, hands everything to 1 other person, and gives from
-- 1 offer set, the one for an Ask the Deal fills for them. No Ask gets more Items than it
-- takes, and a payer's cash stays within the ceiling of the Ask they give for.
create or replace function public.stage_deal(
  p_deal jsonb,
  p_mode public.deal_mode default 'live',
  p_run_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_legs jsonb := coalesce(p_deal->'item_legs', '[]'::jsonb);
  v_cash jsonb := coalesce(p_deal->'cash_legs', '[]'::jsonb);
  v_items uuid[];
  v_users uuid[];
  v_deal_id uuid;
  v_ready boolean;
  leg jsonb;
begin
  if jsonb_typeof(v_legs) <> 'array' or jsonb_array_length(v_legs) < 2
     or jsonb_typeof(v_cash) <> 'array' then
    return jsonb_build_object('result', 'invalid');
  end if;
  v_items := array(select (l->>'item_id')::uuid from jsonb_array_elements(v_legs) l);
  v_users := array(select distinct (l->>'receiver')::uuid from jsonb_array_elements(v_legs) l);
  if cardinality(v_users) not between 2 and 4
     -- Everyone who receives also gives, and nobody else gives.
     or (select count(distinct l->>'giver') from jsonb_array_elements(v_legs) l) <> cardinality(v_users)
     or exists (select 1 from jsonb_array_elements(v_legs) l where not ((l->>'giver')::uuid = any (v_users)))
     -- Each giver hands everything to 1 person, from 1 offer set.
     or exists (
       select 1 from jsonb_array_elements(v_legs) l
        group by l->>'giver'
       having count(distinct l->>'receiver') > 1 or count(distinct coalesce(l->>'giver_ask_id', '')) > 1
     )
     -- That offer set belongs to an Ask the Deal fills for the giver.
     or exists (
       select 1 from jsonb_array_elements(v_legs) g
        where not exists (
          select 1 from jsonb_array_elements(v_legs) r
           where r->>'receiver' = g->>'giver' and r->>'ask_id' = g->>'giver_ask_id'
        )
     )
     or (select count(distinct x) from unnest(v_items) x) <> cardinality(v_items) then
    return jsonb_build_object('result', 'invalid');
  end if;

  for leg in select * from jsonb_array_elements(v_legs) loop
    if not exists (
      select 1 from public.asks
       where id = (leg->>'ask_id')::uuid and user_id = (leg->>'receiver')::uuid and status = 'prospecting'
    ) then
      return jsonb_build_object('result', 'ask_unavailable');
    end if;
    if not exists (
      select 1
        from public.offer_sets o
        join public.asks k on k.id = o.ask_id
        join public.items i on i.id = o.item_id
       where o.ask_id = (leg->>'giver_ask_id')::uuid
         and o.item_id = (leg->>'item_id')::uuid
         and k.user_id = (leg->>'giver')::uuid
         and i.owner_id = (leg->>'giver')::uuid
    ) then
      return jsonb_build_object('result', 'offer_changed');
    end if;
  end loop;

  -- No Ask gets more Items than it takes.
  if exists (
    select 1
      from jsonb_array_elements(v_legs) l
      join public.asks a on a.id = (l->>'ask_id')::uuid
     group by a.id, a.max_items
    having count(*) > a.max_items
  ) then
    return jsonb_build_object('result', 'invalid');
  end if;

  -- Cash: payer and payee are participants, and each payer stays within the ceiling of the
  -- Ask they give for (the 1 the Loop fills for them).
  if exists (
    select 1 from jsonb_array_elements(v_cash) c
     where not ((c->>'payer')::uuid = any (v_users))
        or not ((c->>'payee')::uuid = any (v_users))
        or (c->>'payer') = (c->>'payee')
        or (c->>'amount_cents')::int <= 0
  ) then
    return jsonb_build_object('result', 'invalid');
  end if;
  if exists (
    select 1
      from (
        select (c->>'payer')::uuid as payer, sum((c->>'amount_cents')::int) as paid
          from jsonb_array_elements(v_cash) c
         group by 1
      ) p
      join (
        select distinct (l->>'giver')::uuid as giver, (l->>'giver_ask_id')::uuid as ask_id
          from jsonb_array_elements(v_legs) l
      ) g on g.giver = p.payer
      join public.asks a on a.id = g.ask_id
     where p.paid > a.cash_ceiling_cents
  ) then
    return jsonb_build_object('result', 'over_ceiling');
  end if;

  begin
    v_ready := not exists (
      select 1 from public.items where id = any (v_items) and readiness <> 'showcase'
    );
    insert into public.deals (mode, status, created_by_run_id, fairness, expires_at)
    values (
      p_mode,
      case when v_ready then 'pending_approvals' else 'staged' end::public.deal_status,
      p_run_id,
      jsonb_build_object(
        'participants', coalesce(p_deal->'fairness', '[]'::jsonb),
        'cash_moved_cents', coalesce((p_deal->>'cash_moved_cents')::int, 0),
        'score', p_deal->'score'
      ),
      now() + case when v_ready then interval '48 hours' else interval '24 hours' end
    )
    returning id into v_deal_id;

    -- Raises P0001 if any Item is already reserved, traded or off the Shelf.
    perform public.reserve_items(v_deal_id, v_items);

    insert into public.deal_legs (deal_id, giver_id, receiver_id, item_id, ask_id, giver_ask_id)
    select v_deal_id, (l->>'giver')::uuid, (l->>'receiver')::uuid, (l->>'item_id')::uuid,
           (l->>'ask_id')::uuid, (l->>'giver_ask_id')::uuid
      from jsonb_array_elements(v_legs) l;
    insert into public.deal_legs (deal_id, giver_id, receiver_id, item_id, throw_in_cents)
    select v_deal_id, (c->>'payer')::uuid, (c->>'payee')::uuid, null, (c->>'amount_cents')::int
      from jsonb_array_elements(v_cash) c;
    -- Each person's why from the Prospector's review, keyed by user ID. Optional.
    insert into public.deal_participants (deal_id, user_id, why)
    select v_deal_id, u, nullif(left(btrim(p_deal->'whys'->>(u::text)), 300), '')
      from unnest(v_users) u;

    -- Every Ask the Deal fills, extras included.
    update public.asks set status = 'proposed'
     where id in (select (l->>'ask_id')::uuid from jsonb_array_elements(v_legs) l);
  exception when sqlstate 'P0001' then
    -- The block's writes (the Deal row included) roll back with it.
    return jsonb_build_object('result', 'items_taken');
  end;

  return jsonb_build_object('result', 'ok', 'deal_id', v_deal_id);
end;
$$;

revoke execute on function public.stage_deal(jsonb, public.deal_mode, uuid) from public, anon, authenticated;

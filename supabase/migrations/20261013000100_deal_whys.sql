-- Milestone 3: each participant's "why" from the Prospector's review (PRD "The Deal Sheet":
-- "Why the GM likes it: 1 or 2 sentences tied to what the user said"). Written once by
-- stage_deal and shown only to that participant.

alter table public.deal_participants
  add column why text check (why is null or char_length(why) <= 300);

-- As in 20261011000100_deal_staging.sql, plus p_deal.whys: { "<user id>": "<why>" }.
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
  -- Everyone receives exactly 1 Item and gives exactly 1, and no Item appears twice.
  if cardinality(v_users) <> jsonb_array_length(v_legs)
     or (select count(distinct l->>'giver') from jsonb_array_elements(v_legs) l) <> cardinality(v_users)
     or exists (select 1 from jsonb_array_elements(v_legs) l where not ((l->>'giver')::uuid = any (v_users)))
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

  -- Cash: payer and payee are participants, and each payer stays within the ceiling of the
  -- Ask this Deal fills for them.
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
      join jsonb_array_elements(v_legs) l on (l->>'receiver')::uuid = p.payer
      join public.asks a on a.id = (l->>'ask_id')::uuid
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

    insert into public.deal_legs (deal_id, giver_id, receiver_id, item_id, ask_id)
    select v_deal_id, (l->>'giver')::uuid, (l->>'receiver')::uuid, (l->>'item_id')::uuid, (l->>'ask_id')::uuid
      from jsonb_array_elements(v_legs) l;
    insert into public.deal_legs (deal_id, giver_id, receiver_id, item_id, throw_in_cents)
    select v_deal_id, (c->>'payer')::uuid, (c->>'payee')::uuid, null, (c->>'amount_cents')::int
      from jsonb_array_elements(v_cash) c;
    -- Each person's why from the Prospector's review, keyed by user ID. Optional.
    insert into public.deal_participants (deal_id, user_id, why)
    select v_deal_id, u, nullif(left(btrim(p_deal->'whys'->>(u::text)), 300), '')
      from unnest(v_users) u;

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

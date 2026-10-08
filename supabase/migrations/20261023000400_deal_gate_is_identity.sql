-- A Deal waits only while the GM can't tell what an Item is (docs/specs/trust-and-verification.md),
-- not while its price range is still wide. 20261023000100 used readiness = 'logged', which also
-- covers "identity known, range too wide": dogfooding, a PS4 its owner had confirmed (500GB,
-- light scratches) held its Deal because pricing came back $95 to $200. Both people see the
-- ranges on the Deal Sheet; a wide one is information, not a reason to wait. Only the
-- check changes in each function below.

-- Identity is known: confirmed by the owner, or read with 0.85 confidence or more (the same
-- bar as compute_item_readiness).
create or replace function public.item_identity_known(p_identity_conf real, p_identity_confirmed boolean)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_identity_confirmed, false) or coalesce(p_identity_conf, 0) >= 0.85;
$$;

-- As in 20261023000100_deals_at_identified.sql, except the check.
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
      select 1 from public.items where id = any (v_items) and not public.item_identity_known(identity_conf, identity_confirmed)
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

-- As in 20261023000100_deals_at_identified.sql, except the check.
create or replace function public.respond_counter(p_user_id uuid, p_counter_id uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_counter public.deal_counters%rowtype;
  v_deal public.deals%rowtype;
  v_legs jsonb;
  v_items uuid[];
  v_new uuid;
  v_ready boolean;
begin
  select c.* into v_counter from public.deal_counters c where c.id = p_counter_id for update;
  if v_counter.id is null or not (p_user_id = any (v_counter.awaiting)) then
    return jsonb_build_object('result', 'not_found');
  end if;
  select d.* into v_deal from public.deals d where d.id = v_counter.deal_id for update;
  if v_counter.status <> 'pending' or v_counter.expires_at <= now()
     or v_deal.status <> 'pending_approvals' or v_deal.expires_at <= now() then
    return jsonb_build_object('result', 'closed');
  end if;
  if v_counter.answers ? p_user_id::text then
    return jsonb_build_object('result', 'decided');
  end if;

  if not p_accept then
    update public.deal_counters
       set answers = answers || jsonb_build_object(p_user_id::text, 'declined'),
           status = 'declined', decided_at = now()
     where id = p_counter_id;
    return jsonb_build_object('result', 'ok', 'status', 'declined');
  end if;

  update public.deal_counters
     set answers = answers || jsonb_build_object(p_user_id::text, 'accepted')
   where id = p_counter_id
  returning * into v_counter;
  if exists (select 1 from unnest(v_counter.awaiting) u where not (v_counter.answers ? u::text)) then
    return jsonb_build_object('result', 'ok', 'status', 'pending');
  end if;

  v_legs := v_counter.proposal->'item_legs';
  v_items := array(select (l->>'item_id')::uuid from jsonb_array_elements(v_legs) l);
  begin
    -- Every Item is still its giver's.
    if exists (
      select 1 from jsonb_array_elements(v_legs) l
       where not exists (
         select 1 from public.items i
          where i.id = (l->>'item_id')::uuid and i.owner_id = (l->>'giver')::uuid
       )
    ) then
      raise exception 'an Item changed hands' using errcode = 'P0001';
    end if;
    v_ready := not exists (
      select 1 from public.items where id = any (v_items) and not public.item_identity_known(identity_conf, identity_confirmed)
    );
    insert into public.deals (mode, status, fairness, expires_at, counter_rounds)
    values (
      v_deal.mode,
      case when v_ready then 'pending_approvals' else 'staged' end::public.deal_status,
      jsonb_build_object(
        'participants', coalesce(v_counter.proposal->'fairness', '[]'::jsonb),
        'cash_moved_cents', coalesce((v_counter.proposal->>'cash_moved_cents')::int, 0),
        'score', v_deal.fairness->'score',
        'counter_id', p_counter_id
      ),
      now() + case when v_ready then interval '48 hours' else interval '24 hours' end,
      v_deal.counter_rounds
    )
    returning id into v_new;

    -- Kept Items move to the new version, dropped ones go back on the Shelf, added ones are
    -- held (reserve_items raises P0001 if one is taken).
    update public.items set reserved_by_deal_id = v_new
     where reserved_by_deal_id = v_deal.id and id = any (v_items);
    update public.items set reserved_by_deal_id = null, status = 'on_shelf'
     where reserved_by_deal_id = v_deal.id;
    perform public.reserve_items(v_new, array(
      select x from unnest(v_items) x
       where not exists (select 1 from public.items i where i.id = x and i.reserved_by_deal_id = v_new)
    ));

    insert into public.deal_legs (deal_id, giver_id, receiver_id, item_id, ask_id, giver_ask_id)
    select v_new, (l->>'giver')::uuid, (l->>'receiver')::uuid, (l->>'item_id')::uuid,
           nullif(l->>'ask_id', '')::uuid, nullif(l->>'giver_ask_id', '')::uuid
      from jsonb_array_elements(v_legs) l;
    insert into public.deal_legs (deal_id, giver_id, receiver_id, item_id, throw_in_cents)
    select v_new, (c->>'payer')::uuid, (c->>'payee')::uuid, null, (c->>'amount_cents')::int
      from jsonb_array_elements(coalesce(v_counter.proposal->'cash_legs', '[]'::jsonb)) c;
    insert into public.deal_participants (deal_id, user_id, why)
    select v_new, p.user_id, p.why from public.deal_participants p where p.deal_id = v_deal.id;

    -- An Ask only the old version filled goes back to looking.
    update public.asks set status = 'prospecting'
     where status = 'proposed'
       and id in (select ask_id from public.deal_legs where deal_id = v_deal.id and ask_id is not null)
       and id not in (select ask_id from public.deal_legs where deal_id = v_new and ask_id is not null);
    update public.deals set status = 'cancelled', superseded_by = v_new where id = v_deal.id;
    update public.deal_counters
       set status = 'accepted', decided_at = now(), new_deal_id = v_new
     where id = p_counter_id;
  exception when sqlstate 'P0001' then
    -- The block's writes roll back; the counter can't happen as proposed.
    update public.deal_counters set status = 'expired', decided_at = now() where id = p_counter_id;
    return jsonb_build_object('result', 'items_taken');
  end;
  return jsonb_build_object('result', 'ok', 'status', 'accepted', 'deal_id', v_new);
end;
$$;

revoke execute on function public.respond_counter(uuid, uuid, boolean) from public, anon, authenticated;

-- As in 20261023000100_deals_at_identified.sql, except the check: a staged Deal goes out
-- once the GM knows what its last Item is.
create or replace function public.promote_staged_deal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.deals d
     set status = 'pending_approvals', expires_at = now() + interval '48 hours'
   where d.id = new.reserved_by_deal_id
     and d.status = 'staged'
     and not exists (
       select 1 from public.items i
        where i.reserved_by_deal_id = d.id and not public.item_identity_known(i.identity_conf, i.identity_confirmed)
     );
  return null;
end;
$$;

drop trigger if exists items_promote_staged_deal on public.items;
create trigger items_promote_staged_deal
  after update on public.items
  for each row
  when (new.reserved_by_deal_id is not null
        and not public.item_identity_known(old.identity_conf, old.identity_confirmed)
        and public.item_identity_known(new.identity_conf, new.identity_confirmed))
  execute function public.promote_staged_deal();

revoke execute on function public.promote_staged_deal() from public, anon, authenticated;

-- Staged Deals whose Items are all known already go out now.
update public.deals d
   set status = 'pending_approvals', expires_at = now() + interval '48 hours'
 where d.status = 'staged'
   and not exists (
     select 1 from public.items i
      where i.reserved_by_deal_id = d.id
        and not public.item_identity_known(i.identity_conf, i.identity_confirmed)
   );

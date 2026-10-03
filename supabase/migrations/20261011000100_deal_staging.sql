-- Milestone 3: staging Deals from the matcher, waiting for showcase photos, and expiry.
-- See docs/contracts/m3-deals.md. PRD "From candidate to Deal Sheet" steps 5 to 8.
--
-- Lifecycle:
--   staged             Items reserved, waiting up to 24 hours for every Item to reach
--                      showcase (nobody sees a Deal Sheet with inventory photos)
--   pending_approvals  every Item is showcase; participants have 48 hours to approve
--   cancelled          expired or declined: Items released, Asks back to prospecting,
--                      which queues a fresh prospect_ask (the re-match)

-- Which Ask each leg fills, so closing a Deal can send exactly those Asks back to work.
alter table public.deal_legs
  add column ask_id uuid references public.asks (id) on delete set null;

-- Closes an open Deal: sets its status, releases its Items and returns its Asks to
-- prospecting. Returns false when the Deal was not open.
create or replace function public.close_deal(p_deal_id uuid, p_status public.deal_status)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.deals set status = p_status
   where id = p_deal_id and status in ('staged', 'pending_approvals');
  if not found then
    return false;
  end if;
  perform public.release_deal_items(p_deal_id);
  update public.asks set status = 'prospecting'
   where status = 'proposed'
     and id in (select ask_id from public.deal_legs where deal_id = p_deal_id and ask_id is not null);
  return true;
end;
$$;

-- Stages 1 matcher Deal (docs/contracts/m3-matcher.md, a `deals` entry) in 1 transaction.
-- Called by the Prospector with the service role, so it re-checks everything the matcher
-- assumed against the database as it is now. Returns { result, deal_id? }:
--   ok               staged (or straight to pending_approvals when every Item is showcase)
--   invalid          malformed: fewer than 2 legs, or people who don't give and get exactly 1
--   ask_unavailable  an Ask isn't its receiver's or isn't prospecting anymore
--   offer_changed    an Item isn't its giver's, or left the offer set it was matched from
--   over_ceiling     someone would pay more than their Ask's cash ceiling
--   items_taken      an Item is reserved, traded or off the Shelf
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
    insert into public.deal_participants (deal_id, user_id)
    select v_deal_id, u from unnest(v_users) u;

    update public.asks set status = 'proposed'
     where id in (select (l->>'ask_id')::uuid from jsonb_array_elements(v_legs) l);
  exception when sqlstate 'P0001' then
    -- The block's writes (the Deal row included) roll back with it.
    return jsonb_build_object('result', 'items_taken');
  end;

  return jsonb_build_object('result', 'ok', 'deal_id', v_deal_id);
end;
$$;

-- A staged Deal goes out for approval once its last Item reaches showcase. The approval
-- clock starts then.
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
        where i.reserved_by_deal_id = d.id and i.readiness <> 'showcase'
     );
  return null;
end;
$$;

-- Not "update of readiness": readiness is set by the items_readiness trigger, so it never
-- appears in the UPDATE's column list. The when clause sees the final row.
create trigger items_promote_staged_deal
  after update on public.items
  for each row
  when (new.readiness = 'showcase' and old.readiness is distinct from 'showcase'
        and new.reserved_by_deal_id is not null)
  execute function public.promote_staged_deal();

-- Cancels every open Deal past its expiry. The worker calls this on a timer.
create or replace function public.expire_deals()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_count int := 0;
begin
  for v_id in
    select id from public.deals
     where status in ('staged', 'pending_approvals') and expires_at <= now()
     for update skip locked
  loop
    if public.close_deal(v_id, 'cancelled') then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

revoke execute on function public.close_deal(uuid, public.deal_status) from public, anon, authenticated;
revoke execute on function public.stage_deal(jsonb, public.deal_mode, uuid) from public, anon, authenticated;
revoke execute on function public.promote_staged_deal() from public, anon, authenticated;
revoke execute on function public.expire_deals() from public, anon, authenticated;

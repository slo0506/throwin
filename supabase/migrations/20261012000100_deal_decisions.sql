-- Milestone 3: approving and declining Deal Sheets. See docs/contracts/m3-deals.md.
-- PRD "The Deal Sheet" and "From candidate to Deal Sheet" step 8.

-- Items an Ask's owner turned down: a declined Deal must not come straight back from the
-- re-match. Server only: no policies.
create table public.ask_exclusions (
  ask_id uuid not null references public.asks (id) on delete cascade,
  item_id uuid not null references public.items (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (ask_id, item_id)
);
alter table public.ask_exclusions enable row level security;

alter table public.deal_participants
  add column decline_reason text check (decline_reason is null or char_length(decline_reason) <= 200);

-- Records p_user_id's approval with a snapshot of exactly the Deal Sheet they approved.
-- When everyone has approved, the Deal is approved and its Asks are accepted. Returns
-- { result, status? }:
--   ok         recorded; status is the Deal's status after it (approved when it was the last)
--   not_found  no such Deal, or the user isn't in it, or it's still staged (never shown)
--   closed     the Deal isn't awaiting approvals, or it expired
--   decided    the user already approved or declined
create or replace function public.approve_deal(p_user_id uuid, p_deal_id uuid, p_snapshot jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deal public.deals%rowtype;
  v_approval public.approval_state;
begin
  select d.* into v_deal from public.deals d where d.id = p_deal_id for update;
  select approval into v_approval from public.deal_participants
   where deal_id = p_deal_id and user_id = p_user_id;
  if v_deal.id is null or v_approval is null or v_deal.status = 'staged' then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_deal.status <> 'pending_approvals' or v_deal.expires_at <= now() then
    return jsonb_build_object('result', 'closed', 'status', v_deal.status);
  end if;
  if v_approval <> 'pending' then
    return jsonb_build_object('result', 'decided', 'status', v_deal.status);
  end if;

  update public.deal_participants
     set approval = 'approved', approved_at = now(), sheet_snapshot = p_snapshot
   where deal_id = p_deal_id and user_id = p_user_id;

  if not exists (
    select 1 from public.deal_participants where deal_id = p_deal_id and approval <> 'approved'
  ) then
    update public.deals set status = 'approved' where id = p_deal_id;
    update public.asks set status = 'accepted'
     where status = 'proposed'
       and id in (select ask_id from public.deal_legs where deal_id = p_deal_id and ask_id is not null);
    return jsonb_build_object('result', 'ok', 'status', 'approved');
  end if;
  return jsonb_build_object('result', 'ok', 'status', 'pending_approvals');
end;
$$;

-- Records p_user_id's decline, remembers the Item they turned down for their Ask, and
-- cancels the Deal: Items are released and every Ask goes back to prospecting, which
-- queues the re-match. Same results as approve_deal.
create or replace function public.decline_deal(p_user_id uuid, p_deal_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deal public.deals%rowtype;
  v_approval public.approval_state;
begin
  select d.* into v_deal from public.deals d where d.id = p_deal_id for update;
  select approval into v_approval from public.deal_participants
   where deal_id = p_deal_id and user_id = p_user_id;
  if v_deal.id is null or v_approval is null or v_deal.status = 'staged' then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_deal.status <> 'pending_approvals' or v_deal.expires_at <= now() then
    return jsonb_build_object('result', 'closed', 'status', v_deal.status);
  end if;
  if v_approval <> 'pending' then
    return jsonb_build_object('result', 'decided', 'status', v_deal.status);
  end if;

  update public.deal_participants
     set approval = 'declined', decline_reason = nullif(btrim(p_reason), '')
   where deal_id = p_deal_id and user_id = p_user_id;
  insert into public.ask_exclusions (ask_id, item_id)
  select ask_id, item_id from public.deal_legs
   where deal_id = p_deal_id and receiver_id = p_user_id and ask_id is not null and item_id is not null
  on conflict do nothing;
  perform public.close_deal(p_deal_id, 'cancelled');
  return jsonb_build_object('result', 'ok', 'status', 'cancelled');
end;
$$;

-- Want candidates now skip Items an Ask's owner declined. Otherwise as in
-- 20261010000100_prospector.sql.
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
revoke execute on function public.approve_deal(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.decline_deal(uuid, uuid, text) from public, anon, authenticated;

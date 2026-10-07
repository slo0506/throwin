-- Counters (decided Oct 7, 2026; docs/specs/agents-and-trading.md, "Counters in natural
-- language"). A participant asks, through their GM, to change a Deal's Items: add or remove
-- Items on either side. The API checks the change and has the matcher re-balance the cash;
-- propose_counter stores it, and the Deal waits. When everyone it asks accepts, a new
-- version replaces the Deal and everyone approves again. A decline leaves the Deal as it
-- was. At most 3 counters per Deal, each open for at most 24 hours.

create type public.counter_status as enum ('pending', 'accepted', 'declined', 'withdrawn', 'expired');

-- Set on a Deal that a counter replaced: the version to show instead.
alter table public.deals add column superseded_by uuid references public.deals (id);

-- Server only: no policies.
create table public.deal_counters (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals (id) on delete cascade,
  proposed_by uuid not null references public.users (id) on delete cascade,
  -- Structured only, never free text: [{ "op": "add" | "remove", "item_id", "giver", "receiver" }].
  changes jsonb not null,
  -- The Deal as it would be, from the matcher: { item_legs, cash_legs, fairness, cash_moved_cents }.
  proposal jsonb not null,
  -- Everyone else whose side changes; all of them must accept.
  awaiting uuid[] not null,
  -- { "<user id>": "accepted" | "declined" }
  answers jsonb not null default '{}'::jsonb,
  status public.counter_status not null default 'pending',
  new_deal_id uuid references public.deals (id),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  expires_at timestamptz not null
);
create unique index deal_counters_open_idx on public.deal_counters (deal_id) where status = 'pending';
alter table public.deal_counters enable row level security;

-- Stores a counter the API checked and balanced. Returns { result, counter_id? }:
--   ok              stored; the Deal waits for the answers
--   not_found       no such Deal, the user isn't in it, or it's still staged
--   closed          not awaiting approvals, or expired
--   counter_open    another counter is still open
--   no_rounds_left  this Deal has had its 3 counters
--   invalid         nobody to ask, or someone outside the Deal
create or replace function public.propose_counter(
  p_user_id uuid,
  p_deal_id uuid,
  p_changes jsonb,
  p_proposal jsonb,
  p_awaiting uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deal public.deals%rowtype;
  v_id uuid;
begin
  select d.* into v_deal from public.deals d where d.id = p_deal_id for update;
  if v_deal.id is null or v_deal.status = 'staged' or not exists (
    select 1 from public.deal_participants where deal_id = p_deal_id and user_id = p_user_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_deal.status <> 'pending_approvals' or v_deal.expires_at <= now() then
    return jsonb_build_object('result', 'closed');
  end if;
  if exists (
    select 1 from public.deal_counters
     where deal_id = p_deal_id and status = 'pending' and expires_at > now()
  ) then
    return jsonb_build_object('result', 'counter_open');
  end if;
  if v_deal.counter_rounds >= 3 then
    return jsonb_build_object('result', 'no_rounds_left');
  end if;
  if coalesce(cardinality(p_awaiting), 0) = 0 or p_user_id = any (p_awaiting) or exists (
    select 1 from unnest(p_awaiting) u
     where not exists (select 1 from public.deal_participants where deal_id = p_deal_id and user_id = u)
  ) then
    return jsonb_build_object('result', 'invalid');
  end if;

  -- An expired one still holds the open slot until expire_deals sweeps it.
  update public.deal_counters set status = 'expired', decided_at = now()
   where deal_id = p_deal_id and status = 'pending';
  update public.deals set counter_rounds = counter_rounds + 1 where id = p_deal_id;
  insert into public.deal_counters (deal_id, proposed_by, changes, proposal, awaiting, expires_at)
  values (
    p_deal_id, p_user_id, p_changes, p_proposal, p_awaiting,
    least(v_deal.expires_at, now() + interval '24 hours')
  )
  returning id into v_id;
  return jsonb_build_object('result', 'ok', 'counter_id', v_id);
end;
$$;

-- Records 1 answer. A decline closes the counter and the Deal goes on as it was. The last
-- acceptance makes the new version: it holds the same Items the counter keeps, releases the
-- ones it drops, reserves the ones it adds, carries the whys over and waits for everyone's
-- approval (or for showcase photos, like any staged Deal). The old Deal is cancelled with
-- superseded_by set; its Asks stay proposed, except any the new version no longer fills.
-- Returns { result, status?, deal_id? }:
--   ok           recorded; status is the counter's (pending until everyone answers)
--   not_found    no such counter, or the user isn't asked
--   closed       the counter or its Deal is no longer open
--   decided      the user already answered
--   items_taken  an added Item went to another Deal or left the Shelf; the counter expires
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
      select 1 from public.items where id = any (v_items) and readiness <> 'showcase'
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

-- The proposer takes their counter back. Returns { result }: ok, not_found or closed.
create or replace function public.withdraw_counter(p_user_id uuid, p_counter_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.deal_counters set status = 'withdrawn', decided_at = now()
   where id = p_counter_id and proposed_by = p_user_id and status = 'pending';
  if found then
    return jsonb_build_object('result', 'ok');
  end if;
  if exists (select 1 from public.deal_counters where id = p_counter_id and proposed_by = p_user_id) then
    return jsonb_build_object('result', 'closed');
  end if;
  return jsonb_build_object('result', 'not_found');
end;
$$;

-- As in 20261011000100_deal_staging.sql, plus: closing a Deal expires its open counter.
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
  update public.deal_counters set status = 'expired', decided_at = now()
   where deal_id = p_deal_id and status = 'pending';
  return true;
end;
$$;

-- As in 20261011000100_deal_staging.sql, plus: counters past their own 24 hours expire,
-- and their Deal goes on.
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
  update public.deal_counters set status = 'expired', decided_at = now()
   where status = 'pending' and expires_at <= now();
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

-- As in 20261012000100_deal_decisions.sql, plus: nobody approves while a counter is open.
-- New result: counter_open.
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
  if exists (
    select 1 from public.deal_counters
     where deal_id = p_deal_id and status = 'pending' and expires_at > now()
  ) then
    return jsonb_build_object('result', 'counter_open', 'status', v_deal.status);
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

revoke execute on function public.propose_counter(uuid, uuid, jsonb, jsonb, uuid[]) from public, anon, authenticated;
revoke execute on function public.respond_counter(uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.withdraw_counter(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.close_deal(uuid, public.deal_status) from public, anon, authenticated;
revoke execute on function public.expire_deals() from public, anon, authenticated;
revoke execute on function public.approve_deal(uuid, uuid, jsonb) from public, anon, authenticated;

-- Matching graph, Deals (2-party trades and Loops), handoffs, payments, ratings, reports.

create table public.edges (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references public.users (id) on delete cascade,
  to_user uuid not null references public.users (id) on delete cascade,
  item_id uuid not null references public.items (id) on delete cascade,
  ask_id uuid references public.asks (id) on delete cascade,
  utility real not null default 0,
  confidence real not null default 0.5 check (confidence between 0 and 1),
  kind public.edge_kind not null,
  computed_at timestamptz not null default now(),
  check (from_user <> to_user)
);
create index edges_from_idx on public.edges (from_user);
create index edges_to_idx on public.edges (to_user);

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  mode public.deal_mode not null default 'live',
  status public.deal_status not null default 'staged',
  created_by_run_id uuid,
  expires_at timestamptz not null default now() + interval '48 hours',
  fairness jsonb not null default '{}'::jsonb,
  counter_rounds int not null default 0 check (counter_rounds between 0 and 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index deals_open_expiry_idx on public.deals (expires_at)
  where status in ('staged', 'pending_approvals');

create trigger deals_updated_at before update on public.deals
  for each row execute function public.set_updated_at();

alter table public.items
  add constraint items_reserved_by_deal_fk
  foreign key (reserved_by_deal_id) references public.deals (id);

create table public.deal_legs (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals (id) on delete cascade,
  giver_id uuid not null references public.users (id) on delete cascade,
  receiver_id uuid not null references public.users (id) on delete cascade,
  item_id uuid references public.items (id) on delete set null,
  throw_in_cents int not null default 0 check (throw_in_cents >= 0),
  check (giver_id <> receiver_id),
  check (item_id is not null or throw_in_cents > 0)
);
create index deal_legs_deal_idx on public.deal_legs (deal_id);
create unique index deal_legs_item_once_per_deal on public.deal_legs (deal_id, item_id)
  where item_id is not null;

create table public.deal_participants (
  deal_id uuid not null references public.deals (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  approval public.approval_state not null default 'pending',
  approved_at timestamptz,
  -- Exactly what this participant saw and approved.
  sheet_snapshot jsonb,
  primary key (deal_id, user_id)
);
create index deal_participants_user_idx on public.deal_participants (user_id);

create or replace function public.is_deal_participant(p_deal_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.deal_participants
    where deal_id = p_deal_id and user_id = auth.uid()
  );
$$;

create table public.liaison_messages (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals (id) on delete cascade,
  from_user uuid not null references public.users (id) on delete cascade,
  to_user uuid not null references public.users (id) on delete cascade,
  type public.liaison_type not null,
  -- Structured fields only. The harness validates the payload per type; no free text.
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index liaison_messages_deal_idx on public.liaison_messages (deal_id, created_at);

create table public.handoffs (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals (id) on delete cascade,
  place_id text,
  place_name text,
  starts_at timestamptz,
  proposed_slots jsonb not null default '[]'::jsonb,
  status public.handoff_status not null default 'proposed',
  checkins jsonb not null default '{}'::jsonb,
  confirmations jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index handoffs_deal_idx on public.handoffs (deal_id);

create trigger handoffs_updated_at before update on public.handoffs
  for each row execute function public.set_updated_at();

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals (id) on delete cascade,
  payer_id uuid not null references public.users (id) on delete cascade,
  payee_id uuid not null references public.users (id) on delete cascade,
  amount_cents int not null check (amount_cents > 0),
  stripe_payment_intent text unique,
  status public.payment_status not null default 'requires_authorization',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger payments_updated_at before update on public.payments
  for each row execute function public.set_updated_at();

create table public.ratings (
  deal_id uuid not null references public.deals (id) on delete cascade,
  rater_id uuid not null references public.users (id) on delete cascade,
  ratee_id uuid not null references public.users (id) on delete cascade,
  score smallint not null check (score between 1 and 5),
  note text check (note is null or char_length(note) <= 280),
  created_at timestamptz not null default now(),
  primary key (deal_id, rater_id, ratee_id),
  check (rater_id <> ratee_id)
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.users (id) on delete cascade,
  target_user_id uuid references public.users (id) on delete set null,
  target_item_id uuid references public.items (id) on delete set null,
  reason text not null check (char_length(reason) between 1 and 500),
  status public.report_status not null default 'open',
  created_at timestamptz not null default now(),
  check (target_user_id is not null or target_item_id is not null)
);

create table public.blocks (
  blocker_id uuid not null references public.users (id) on delete cascade,
  blocked_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

-- ---------------------------------------------------------------------------
-- Reservation: an Item can be reserved by only 1 Deal at a time.
-- The guarded update is atomic: either every Item is reserved for this Deal or none are.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_items(p_deal_id uuid, p_item_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reserved int;
  v_wanted int := coalesce(array_length(p_item_ids, 1), 0);
begin
  if v_wanted = 0 then
    return;
  end if;

  update public.items
     set reserved_by_deal_id = p_deal_id,
         status = 'reserved'
   where id = any (p_item_ids)
     and status = 'on_shelf'
     and reserved_by_deal_id is null;
  get diagnostics v_reserved = row_count;

  if v_reserved <> v_wanted then
    raise exception 'items already reserved or unavailable (% of % reserved)', v_reserved, v_wanted
      using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.release_deal_items(p_deal_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released int;
begin
  update public.items
     set reserved_by_deal_id = null,
         status = 'on_shelf'
   where reserved_by_deal_id = p_deal_id;
  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

-- Only the server (service role) moves Items in and out of Deals.
revoke execute on function public.reserve_items(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.release_deal_items(uuid) from public, anon, authenticated;

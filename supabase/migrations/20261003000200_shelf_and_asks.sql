-- Shelf (Items, media, embeddings, appraisals), Asks, offer sets and taste facts.

create table public.items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users (id) on delete cascade,
  status public.item_status not null default 'draft',
  category text,
  brand text,
  model text,
  variant text,
  title text not null default '' check (char_length(title) <= 120),
  attributes jsonb not null default '{}'::jsonb,
  condition_grade public.condition_grade,
  defects text[] not null default '{}',
  value_low_cents int check (value_low_cents >= 0),
  value_mid_cents int check (value_mid_cents >= 0),
  value_high_cents int check (value_high_cents >= 0),
  identity_conf real check (identity_conf between 0 and 1),
  condition_conf real check (condition_conf between 0 and 1),
  willingness public.item_willingness not null default 'would_trade',
  follow_up text,
  -- 1 Deal per Item. Only reserve_items() and release_deal_items() write this.
  reserved_by_deal_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (value_low_cents is null or value_high_cents is null or value_low_cents <= value_high_cents),
  check (
    value_mid_cents is null
    or (value_low_cents <= value_mid_cents and value_mid_cents <= value_high_cents)
  ),
  check ((status = 'reserved') = (reserved_by_deal_id is not null))
);
create index items_owner_idx on public.items (owner_id) where status <> 'removed';
create index items_reserved_idx on public.items (reserved_by_deal_id) where reserved_by_deal_id is not null;

create trigger items_updated_at before update on public.items
  for each row execute function public.set_updated_at();

create table public.item_media (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items (id) on delete cascade,
  storage_path text not null,
  kind public.media_kind not null default 'photo',
  width int,
  height int,
  sharpness real,
  crop_box jsonb,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index item_media_item_idx on public.item_media (item_id, position);

create table public.item_embeddings (
  item_id uuid not null references public.items (id) on delete cascade,
  model text not null,
  embedding extensions.vector(1024) not null,
  created_at timestamptz not null default now(),
  primary key (item_id, model)
);
create index item_embeddings_hnsw on public.item_embeddings
  using hnsw (embedding extensions.vector_cosine_ops);

create table public.appraisals (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items (id) on delete cascade,
  model text not null,
  input_media_ids uuid[] not null default '{}',
  output jsonb not null,
  comps jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index appraisals_item_idx on public.appraisals (item_id, created_at desc);

create table public.asks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  raw_text text not null check (char_length(raw_text) between 1 and 500),
  target jsonb not null default '{}'::jsonb,
  status public.ask_status not null default 'drafting',
  -- Private to the asker. Never returned by network functions.
  cash_ceiling_cents int not null default 0 check (cash_ceiling_cents between 0 and 100000),
  deadline timestamptz,
  autonomy public.autonomy_level not null default 'every_deal',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index asks_user_idx on public.asks (user_id, status);

create trigger asks_updated_at before update on public.asks
  for each row execute function public.set_updated_at();

create table public.offer_sets (
  ask_id uuid not null references public.asks (id) on delete cascade,
  item_id uuid not null references public.items (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (ask_id, item_id)
);

-- An offer set may only contain the asker's own Items.
create or replace function public.check_offer_set_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.asks a
    join public.items i on i.owner_id = a.user_id
    where a.id = new.ask_id and i.id = new.item_id
  ) then
    raise exception 'offer set item must belong to the asker' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger offer_sets_owner_check before insert or update on public.offer_sets
  for each row execute function public.check_offer_set_owner();

create table public.taste_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  key text not null check (char_length(key) between 1 and 80),
  value text not null check (char_length(value) between 1 and 400),
  category text not null default 'general',
  source_session_id uuid,
  confidence real not null default 0.7 check (confidence between 0 and 1),
  always_on boolean not null default false,
  status public.taste_fact_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index taste_facts_user_idx on public.taste_facts (user_id) where status = 'active';

create trigger taste_facts_updated_at before update on public.taste_facts
  for each row execute function public.set_updated_at();

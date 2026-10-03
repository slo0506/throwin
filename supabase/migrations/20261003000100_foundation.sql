-- Throw-In foundation: extensions, enums, shared helpers, people and Circles.

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- State machines (PRD: Domain objects and the Ask lifecycle)
-- ---------------------------------------------------------------------------
create type public.circle_status as enum ('active', 'paused');
create type public.circle_role as enum ('owner', 'member');
create type public.item_status as enum ('draft', 'needs_photos', 'on_shelf', 'reserved', 'traded', 'removed');
create type public.item_willingness as enum ('would_trade', 'open_to_offers', 'not_available');
create type public.condition_grade as enum ('A', 'B', 'C', 'D');
create type public.ask_status as enum ('drafting', 'offering', 'prospecting', 'proposed', 'accepted', 'fulfilled', 'expired', 'cancelled');
create type public.autonomy_level as enum ('every_deal', 'likely_yes');
create type public.deal_mode as enum ('live', 'drop');
create type public.deal_status as enum ('staged', 'pending_approvals', 'approved', 'scheduling', 'in_handoff', 'completed', 'failed', 'cancelled');
create type public.approval_state as enum ('pending', 'approved', 'declined');
create type public.handoff_status as enum ('proposed', 'confirmed', 'done', 'no_show', 'disputed');
create type public.taste_fact_status as enum ('active', 'superseded', 'deleted');
create type public.edge_kind as enum ('explicit', 'inferred');
create type public.liaison_type as enum ('inquiry', 'answer', 'counter', 'withdraw');
create type public.payment_status as enum ('requires_authorization', 'authorized', 'captured', 'cancelled', 'failed', 'disputed');
create type public.media_kind as enum ('photo', 'frame');
create type public.message_role as enum ('user', 'assistant');
create type public.report_status as enum ('open', 'reviewing', 'actioned', 'dismissed');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  apple_sub text unique,
  display_name text not null default '' check (char_length(display_name) <= 60),
  photo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.profiles (
  user_id uuid primary key references public.users (id) on delete cascade,
  -- Coarse geohash (5 chars, about 5 km). Never an exact address.
  home_area text check (home_area is null or char_length(home_area) <= 6),
  default_handoff_place_id text,
  autonomy_level public.autonomy_level not null default 'every_deal',
  notification_prefs jsonb not null default '{"deal_ready": true, "item_wanted": true, "approval_nudge": true, "handoff_reminder": true, "ask_update": true, "promotional": false}'::jsonb,
  ai_consent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger users_updated_at before update on public.users
  for each row execute function public.set_updated_at();
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Mirror every new auth user into public.users and public.profiles.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, display_name, apple_sub)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'first_name', new.raw_user_meta_data ->> 'name', ''), 60),
    new.raw_user_meta_data ->> 'apple_sub'
  )
  on conflict (id) do nothing;
  insert into public.profiles (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Circles
-- ---------------------------------------------------------------------------
create table public.circles (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  owner_id uuid not null references public.users (id) on delete cascade,
  radius_km numeric(6, 1) not null default 15 check (radius_km > 0),
  category_focus text[] not null default '{}',
  default_handoff_place_id text,
  status public.circle_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.circle_members (
  circle_id uuid not null references public.circles (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  role public.circle_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (circle_id, user_id)
);
create index circle_members_user_idx on public.circle_members (user_id);

create table public.invites (
  code text primary key check (code ~ '^[A-Za-z0-9_-]{6,32}$'),
  circle_id uuid not null references public.circles (id) on delete cascade,
  created_by uuid not null references public.users (id) on delete cascade,
  max_uses int not null default 25 check (max_uses > 0),
  uses int not null default 0 check (uses >= 0),
  expires_at timestamptz not null default now() + interval '14 days',
  created_at timestamptz not null default now(),
  check (uses <= max_uses)
);

create trigger circles_updated_at before update on public.circles
  for each row execute function public.set_updated_at();

-- Membership checks are security definer so RLS policies can use them without recursion.
create or replace function public.is_circle_member(p_circle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.circle_members
    where circle_id = p_circle_id and user_id = auth.uid()
  );
$$;

create or replace function public.shares_circle_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.circle_members mine
    join public.circle_members theirs on theirs.circle_id = mine.circle_id
    where mine.user_id = auth.uid() and theirs.user_id = p_user_id
  );
$$;

-- When a Circle is created, its owner becomes a member.
create or replace function public.handle_new_circle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.circle_members (circle_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict do nothing;
  return new;
end;
$$;

create trigger on_circle_created
  after insert on public.circles
  for each row execute function public.handle_new_circle();

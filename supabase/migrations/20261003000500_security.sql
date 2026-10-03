-- Row-level security for every table, plus the network read functions.
-- Rule: users read and write their own rows. Anything about other people goes through
-- security definer functions that return only fields safe to share.

alter table public.users enable row level security;
alter table public.profiles enable row level security;
alter table public.circles enable row level security;
alter table public.circle_members enable row level security;
alter table public.invites enable row level security;
alter table public.items enable row level security;
alter table public.item_media enable row level security;
alter table public.item_embeddings enable row level security;
alter table public.appraisals enable row level security;
alter table public.asks enable row level security;
alter table public.offer_sets enable row level security;
alter table public.taste_facts enable row level security;
alter table public.edges enable row level security;
alter table public.deals enable row level security;
alter table public.deal_legs enable row level security;
alter table public.deal_participants enable row level security;
alter table public.liaison_messages enable row level security;
alter table public.handoffs enable row level security;
alter table public.payments enable row level security;
alter table public.ratings enable row level security;
alter table public.reports enable row level security;
alter table public.blocks enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_events enable row level security;
alter table public.notifications enable row level security;
alter table public.idempotency_keys enable row level security;

-- People ---------------------------------------------------------------------
create policy users_select_self on public.users
  for select to authenticated using (id = (select auth.uid()));
create policy users_update_self on public.users
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy profiles_select_self on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));
create policy profiles_update_self on public.profiles
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Circles ----------------------------------------------------------------------
create policy circles_select_member on public.circles
  for select to authenticated using (public.is_circle_member(id));
create policy circles_insert_owner on public.circles
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy circles_update_owner on public.circles
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create policy circle_members_select_member on public.circle_members
  for select to authenticated using (public.is_circle_member(circle_id));
create policy circle_members_leave on public.circle_members
  for delete to authenticated using (user_id = (select auth.uid()));

create policy invites_select_member on public.invites
  for select to authenticated using (public.is_circle_member(circle_id));
create policy invites_insert_member on public.invites
  for insert to authenticated
  with check (created_by = (select auth.uid()) and public.is_circle_member(circle_id));

-- Shelf ------------------------------------------------------------------------
create policy items_owner_all on public.items
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and reserved_by_deal_id is null and status <> 'reserved');

create policy item_media_owner_all on public.item_media
  for all to authenticated
  using (exists (select 1 from public.items i where i.id = item_id and i.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.items i where i.id = item_id and i.owner_id = (select auth.uid())));

create policy appraisals_owner_select on public.appraisals
  for select to authenticated
  using (exists (select 1 from public.items i where i.id = item_id and i.owner_id = (select auth.uid())));

-- item_embeddings: server only (no policies).

-- Asks and taste ---------------------------------------------------------------
create policy asks_owner_all on public.asks
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy offer_sets_owner_all on public.offer_sets
  for all to authenticated
  using (exists (select 1 from public.asks a where a.id = ask_id and a.user_id = (select auth.uid())))
  with check (exists (select 1 from public.asks a where a.id = ask_id and a.user_id = (select auth.uid())));

create policy taste_facts_owner_select on public.taste_facts
  for select to authenticated using (user_id = (select auth.uid()));
create policy taste_facts_owner_update on public.taste_facts
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy taste_facts_owner_delete on public.taste_facts
  for delete to authenticated using (user_id = (select auth.uid()));

-- Deals ------------------------------------------------------------------------
-- Participants can read Deals they are in. Every state change goes through the API.
create policy deals_participant_select on public.deals
  for select to authenticated using (public.is_deal_participant(id));
create policy deal_legs_participant_select on public.deal_legs
  for select to authenticated using (public.is_deal_participant(deal_id));
create policy deal_participants_participant_select on public.deal_participants
  for select to authenticated using (public.is_deal_participant(deal_id));
create policy handoffs_participant_select on public.handoffs
  for select to authenticated using (public.is_deal_participant(deal_id));
create policy payments_party_select on public.payments
  for select to authenticated using (payer_id = (select auth.uid()) or payee_id = (select auth.uid()));

-- edges, liaison_messages: server only (no policies).

create policy ratings_rater_select on public.ratings
  for select to authenticated using (rater_id = (select auth.uid()));

create policy reports_reporter_insert on public.reports
  for insert to authenticated with check (reporter_id = (select auth.uid()));
create policy reports_reporter_select on public.reports
  for select to authenticated using (reporter_id = (select auth.uid()));

create policy blocks_owner_all on public.blocks
  for all to authenticated
  using (blocker_id = (select auth.uid())) with check (blocker_id = (select auth.uid()));

-- Agents -----------------------------------------------------------------------
create policy conversations_owner_select on public.conversations
  for select to authenticated using (user_id = (select auth.uid()));
create policy messages_owner_select on public.messages
  for select to authenticated using (user_id = (select auth.uid()));
create policy agent_events_owner_visible on public.agent_events
  for select to authenticated using (user_id = (select auth.uid()) and user_visible);
create policy notifications_owner_select on public.notifications
  for select to authenticated using (user_id = (select auth.uid()));

-- agent_runs, idempotency_keys: server only (no policies).

-- ---------------------------------------------------------------------------
-- Network reads: only fields safe to share, only within shared Circles,
-- never blocked users, never value floors or cash ceilings.
-- ---------------------------------------------------------------------------
create or replace function public.network_items(p_circle_id uuid)
returns table (
  item_id uuid,
  owner_id uuid,
  owner_display_name text,
  title text,
  category text,
  brand text,
  model text,
  condition_grade public.condition_grade,
  value_low_cents int,
  value_high_cents int,
  willingness public.item_willingness
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.owner_id, u.display_name, i.title, i.category, i.brand, i.model,
         i.condition_grade, i.value_low_cents, i.value_high_cents, i.willingness
  from public.items i
  join public.users u on u.id = i.owner_id and u.deleted_at is null
  join public.circle_members cm on cm.user_id = i.owner_id and cm.circle_id = p_circle_id
  where public.is_circle_member(p_circle_id)
    and i.owner_id <> auth.uid()
    and i.status = 'on_shelf'
    and i.willingness <> 'not_available'
    and not exists (
      select 1 from public.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = i.owner_id)
         or (b.blocker_id = i.owner_id and b.blocked_id = auth.uid())
    );
$$;

create or replace function public.circle_roster(p_circle_id uuid)
returns table (user_id uuid, display_name text, photo_url text, role public.circle_role, joined_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.display_name, u.photo_url, cm.role, cm.joined_at
  from public.circle_members cm
  join public.users u on u.id = cm.user_id and u.deleted_at is null
  where cm.circle_id = p_circle_id and public.is_circle_member(p_circle_id)
  order by cm.joined_at;
$$;

revoke execute on function public.network_items(uuid) from public, anon;
revoke execute on function public.circle_roster(uuid) from public, anon;
grant execute on function public.network_items(uuid) to authenticated;
grant execute on function public.circle_roster(uuid) to authenticated;

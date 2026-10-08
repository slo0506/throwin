-- Inferred edges and the Liaison's question (decided Oct 7, 2026;
-- docs/specs/agents-and-trading.md, "Mary wants an Xbox; she might take a PS5"). When the
-- best Loop rests on a guess (an Item in the same top-level category as an Ask, but not
-- what it named), nobody gets a Deal Sheet yet. The wanter's side is asked first: their GM
-- answers from their taste facts when those settle it, otherwise the person gets 1 tap.
-- Yes turns the guess into a want and re-matches the Ask; no keeps the Item away from that
-- Ask for good. Limits: 1 question per Ask a day, 5 a day per person asked, 20 an hour per
-- giver, each open for 24 hours. Server only.

create type public.inquiry_status as enum ('pending', 'yes', 'no', 'expired');

create table public.inquiries (
  id uuid primary key default gen_random_uuid(),
  -- The Ask the Item might fill, and its owner, who answers.
  ask_id uuid not null references public.asks (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  item_id uuid not null references public.items (id) on delete cascade,
  giver_id uuid not null references public.users (id) on delete cascade,
  status public.inquiry_status not null default 'pending',
  answered_by text check (answered_by in ('gm', 'user')),
  -- The GM's reason when it answered from taste facts. Shown only to the person asked.
  reason text check (reason is null or char_length(reason) <= 200),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours',
  unique (ask_id, item_id)
);
create index inquiries_user_idx on public.inquiries (user_id, created_at desc);
create index inquiries_giver_idx on public.inquiries (giver_id, created_at desc);
alter table public.inquiries enable row level security;

-- Opens 1 question within the limits, and queues the Liaison to try answering it from the
-- person's taste facts. Returns { result, inquiry_id? }:
--   ok       opened
--   exists   this Ask and Item were already asked about
--   limited  a limit says not now
--   invalid  the Ask isn't prospecting, or the Item isn't the giver's
create or replace function public.create_inquiry(p_ask_id uuid, p_item_id uuid, p_giver_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ask public.asks%rowtype;
  v_id uuid;
begin
  select a.* into v_ask from public.asks a where a.id = p_ask_id for update;
  if v_ask.id is null or v_ask.status <> 'prospecting' or v_ask.user_id = p_giver_id
     or not exists (select 1 from public.items where id = p_item_id and owner_id = p_giver_id) then
    return jsonb_build_object('result', 'invalid');
  end if;
  if exists (select 1 from public.inquiries where ask_id = p_ask_id and item_id = p_item_id) then
    return jsonb_build_object('result', 'exists');
  end if;
  if exists (
       select 1 from public.inquiries
        where ask_id = p_ask_id and created_at > now() - interval '24 hours'
     )
     or (select count(*) from public.inquiries
          where user_id = v_ask.user_id and created_at > now() - interval '24 hours') >= 5
     or (select count(*) from public.inquiries
          where giver_id = p_giver_id and created_at > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('result', 'limited');
  end if;

  insert into public.inquiries (ask_id, user_id, item_id, giver_id)
  values (p_ask_id, v_ask.user_id, p_item_id, p_giver_id)
  returning id into v_id;
  insert into public.jobs (kind, payload)
  values ('answer_inquiry', jsonb_build_object('inquiry_id', v_id, 'user_id', v_ask.user_id));
  return jsonb_build_object('result', 'ok', 'inquiry_id', v_id);
end;
$$;

-- Records the answer, from the person or their GM. Returns { result }: ok, not_found
-- (no such question, or not theirs) or closed (answered or expired).
create or replace function public.answer_inquiry(
  p_user_id uuid,
  p_inquiry_id uuid,
  p_yes boolean,
  p_by text default 'user',
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inquiry public.inquiries%rowtype;
begin
  select i.* into v_inquiry from public.inquiries i where i.id = p_inquiry_id for update;
  if v_inquiry.id is null or v_inquiry.user_id <> p_user_id then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_inquiry.status <> 'pending' or v_inquiry.expires_at <= now() then
    return jsonb_build_object('result', 'closed');
  end if;

  update public.inquiries
     set status = case when p_yes then 'yes' else 'no' end::public.inquiry_status,
         answered_by = p_by,
         reason = nullif(left(btrim(coalesce(p_reason, '')), 200), ''),
         answered_at = now()
   where id = p_inquiry_id;
  if p_yes then
    -- The guess is a want now: match again with it.
    perform public.enqueue_prospect_ask(v_inquiry.ask_id, v_inquiry.user_id);
  else
    insert into public.ask_exclusions (ask_id, item_id)
    values (v_inquiry.ask_id, v_inquiry.item_id)
    on conflict do nothing;
  end if;
  return jsonb_build_object('result', 'ok');
end;
$$;

-- Closes questions nobody answered within 24 hours. The worker calls it every minute.
create or replace function public.expire_inquiries()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  update public.inquiries set status = 'expired'
   where status = 'pending' and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.create_inquiry(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.answer_inquiry(uuid, uuid, boolean, text, text) from public, anon, authenticated;
revoke execute on function public.expire_inquiries() from public, anon, authenticated;

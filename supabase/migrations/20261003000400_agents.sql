-- GM conversations, agent observability, notifications and API idempotency.

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_user_idx on public.conversations (user_id, updated_at desc);

create trigger conversations_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  role public.message_role not null,
  -- API-native content blocks, so reloading renders the same cards.
  content jsonb not null,
  tool_calls jsonb,
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  trigger text not null,
  user_id uuid references public.users (id) on delete set null,
  ask_id uuid references public.asks (id) on delete set null,
  model text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  cost_cents numeric(10, 4) not null default 0,
  latency_ms int,
  outcome text,
  created_at timestamptz not null default now()
);
create index agent_runs_user_idx on public.agent_runs (user_id, created_at desc);

create table public.agent_events (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.agent_runs (id),
  user_id uuid references public.users (id) on delete set null,
  type text not null,
  -- user_visible events power the Activity log. Others are internal traces.
  user_visible boolean not null default false,
  summary text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index agent_events_run_idx on public.agent_events (run_id);
create index agent_events_user_visible_idx on public.agent_events (user_id, created_at desc)
  where user_visible;

-- Append-only. The only permitted change is anonymizing user_id on account deletion.
create or replace function public.agent_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.user_id is null
     and old.user_id is not null
     and new.run_id = old.run_id
     and new.type = old.type
     and new.payload = old.payload
     and new.created_at = old.created_at then
    return new;
  end if;
  raise exception 'agent_events is append-only' using errcode = '42501';
end;
$$;

create trigger agent_events_no_update before update on public.agent_events
  for each row execute function public.agent_events_append_only();
create trigger agent_events_no_delete before delete on public.agent_events
  for each row execute function public.agent_events_append_only();

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  kind text not null check (kind in ('deal_ready', 'item_wanted', 'approval_nudge', 'handoff_reminder', 'ask_update')),
  payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  opened_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_sent_idx on public.notifications (user_id, sent_at desc);

create table public.idempotency_keys (
  user_id uuid not null references public.users (id) on delete cascade,
  key text not null check (char_length(key) between 8 and 128),
  method text not null,
  path text not null,
  request_hash text not null,
  status_code int,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);
create index idempotency_keys_created_idx on public.idempotency_keys (created_at);

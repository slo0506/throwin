-- Milestone 1: media storage, captures, and a Postgres-backed job queue.

-- Private bucket for item photos, video frames and crops. Clients never read or write it
-- directly: the API hands out signed upload URLs and short-lived signed read URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-media', 'item-media', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

create type public.capture_status as enum ('uploading', 'processing', 'done', 'failed');
create type public.job_status as enum ('queued', 'running', 'done', 'failed');

-- A capture is 1 session in the camera: a short video's frames or a few photos.
create table public.captures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  status public.capture_status not null default 'uploading',
  media_count int not null default 0 check (media_count between 0 and 30),
  item_count int not null default 0,
  -- What the user sees while it works, e.g. {"stage": "identifying", "detail": "Reading 4 items"}.
  progress jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index captures_user_idx on public.captures (user_id, created_at desc);

create trigger captures_updated_at before update on public.captures
  for each row execute function public.set_updated_at();

create table public.capture_media (
  id uuid primary key default gen_random_uuid(),
  capture_id uuid not null references public.captures (id) on delete cascade,
  storage_path text not null unique,
  kind public.media_kind not null default 'photo',
  width int,
  height int,
  sharpness real,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index capture_media_capture_idx on public.capture_media (capture_id, position);

alter table public.items add column capture_id uuid references public.captures (id) on delete set null;
create index items_capture_idx on public.items (capture_id) where capture_id is not null;

-- Background jobs. Workers claim with claim_job(), which uses SKIP LOCKED so several
-- workers can run without stepping on each other. Keeps v1 to 1 database (PRD).
create table public.jobs (
  id bigint generated always as identity primary key,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status public.job_status not null default 'queued',
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_ready_idx on public.jobs (kind, run_after) where status = 'queued';

create trigger jobs_updated_at before update on public.jobs
  for each row execute function public.set_updated_at();

create or replace function public.claim_job(p_kinds text[], p_stale_after interval default interval '10 minutes')
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Requeue jobs whose worker died mid-run.
  update public.jobs
     set status = 'queued', locked_at = null
   where status = 'running' and locked_at < now() - p_stale_after;

  return query
  update public.jobs j
     set status = 'running', locked_at = now(), attempts = j.attempts + 1
   where j.id = (
     select id from public.jobs
      where status = 'queued' and run_after <= now() and kind = any (p_kinds)
      order by run_after, id
      for update skip locked
      limit 1
   )
  returning j.*;
end;
$$;

create or replace function public.finish_job(p_id bigint, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_error is null then
    update public.jobs set status = 'done', locked_at = null, last_error = null where id = p_id;
  else
    -- Exponential backoff: 30s, 2m, 8m. Out of attempts means failed for good.
    update public.jobs
       set status = case when attempts >= max_attempts then 'failed'::public.job_status else 'queued'::public.job_status end,
           locked_at = null,
           last_error = left(p_error, 2000),
           run_after = now() + (interval '30 seconds' * power(4, greatest(attempts - 1, 0)))
     where id = p_id;
  end if;
end;
$$;

revoke execute on function public.claim_job(text[], interval) from public, anon, authenticated;
revoke execute on function public.finish_job(bigint, text) from public, anon, authenticated;

alter table public.captures enable row level security;
alter table public.capture_media enable row level security;
alter table public.jobs enable row level security;

create policy captures_owner_select on public.captures
  for select to authenticated using (user_id = (select auth.uid()));
create policy capture_media_owner_select on public.capture_media
  for select to authenticated
  using (exists (select 1 from public.captures c where c.id = capture_id and c.user_id = (select auth.uid())));
-- jobs: server only (no policies).

-- Atomically records a capture's uploaded media, moves it to processing and enqueues the
-- Appraiser. Called by the API with the service role after it checks ownership and paths.
create or replace function public.submit_capture(p_user_id uuid, p_capture_id uuid, p_media jsonb, p_kind public.media_kind default 'photo')
returns public.captures
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capture public.captures;
  v_count int := jsonb_array_length(p_media);
begin
  select * into v_capture from public.captures
   where id = p_capture_id and user_id = p_user_id
   for update;
  if not found then
    return null;
  end if;
  if v_capture.status <> 'uploading' then
    raise exception 'capture already submitted' using errcode = 'P0002';
  end if;

  insert into public.capture_media (capture_id, storage_path, width, height, sharpness, position, kind)
  select p_capture_id,
         m ->> 'path',
         (m ->> 'width')::int,
         (m ->> 'height')::int,
         (m ->> 'sharpness')::real,
         (t.ordinality - 1)::int,
         p_kind
    from jsonb_array_elements(p_media) with ordinality as t(m, ordinality);

  update public.captures
     set status = 'processing',
         media_count = v_count,
         progress = jsonb_build_object('stage', 'detecting', 'detail', 'Looking at your photos')
   where id = p_capture_id
  returning * into v_capture;

  insert into public.jobs (kind, payload)
  values ('appraise_capture', jsonb_build_object('capture_id', p_capture_id, 'user_id', p_user_id));

  return v_capture;
end;
$$;

revoke execute on function public.submit_capture(uuid, uuid, jsonb, public.media_kind) from public, anon, authenticated;

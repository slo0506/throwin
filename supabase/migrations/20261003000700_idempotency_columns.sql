-- Align idempotency_keys with services/api/src/repo/supabase-idempotency.ts.
-- The store keeps the raw response body as text with its content type, and expires keys.
-- The original status_code and response columns stay (nullable, unused) so this migration
-- is additive only.
alter table public.idempotency_keys
  add column if not exists expires_at timestamptz not null default now() + interval '24 hours',
  add column if not exists response_status int,
  add column if not exists response_body text,
  add column if not exists response_content_type text,
  add column if not exists completed_at timestamptz;

create index if not exists idempotency_keys_expires_idx on public.idempotency_keys (expires_at);

comment on column public.idempotency_keys.status_code is 'Unused. Superseded by response_status.';
comment on column public.idempotency_keys.response is 'Unused. Superseded by response_body.';

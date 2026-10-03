-- Align idempotency_keys with services/api/src/repo/supabase-idempotency.ts.
-- The store keeps the raw response body as text with its content type, and expires keys.
alter table public.idempotency_keys
  drop column if exists status_code,
  drop column if exists response,
  add column expires_at timestamptz not null default now() + interval '24 hours',
  add column response_status int,
  add column response_body text,
  add column response_content_type text,
  add column completed_at timestamptz;

create index if not exists idempotency_keys_expires_idx on public.idempotency_keys (expires_at);

-- Columns the API's Supabase repositories read and write. If a migration renames one,
-- this fails here instead of as a 500 in production.
\set ON_ERROR_STOP on

do $$
begin
  insert into public.idempotency_keys
    (user_id, key, method, path, request_hash, expires_at, response_status, response_body, response_content_type, completed_at)
  values
    ('00000000-0000-4000-8000-000000000001', 'contract-test-key', 'PATCH', '/v1/me', 'hash', now(), 200, '{}', 'application/json', now());
  delete from public.idempotency_keys where key = 'contract-test-key';

  perform id, display_name, photo_url, created_at, deleted_at from public.users limit 1;
  perform autonomy_level, notification_prefs, home_area, default_handoff_place_id from public.profiles limit 1;
  perform id, owner_id, status, title, willingness, category, brand, model, variant, condition_grade, defects,
          value_low_cents, value_mid_cents, value_high_cents, identity_conf, condition_conf,
          reserved_by_deal_id, follow_up, capture_id, appraising, created_at, updated_at
    from public.items limit 1;
  perform storage_path, position from public.item_media limit 1;
  perform product_key, condition_grade, value_low_cents, value_mid_cents, value_high_cents,
          confidence, basis, research, model, prompt_version, created_at
    from public.price_cache limit 1;
end $$;

select 'api contract tests passed' as result;

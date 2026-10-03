-- A range is also narrow when its spread is $30 or less, so cheap items like a $45 to $75
-- lamp can reach identified. Mirrors isNarrowRange in packages/shared/src/readiness.ts.
create or replace function public.compute_item_readiness(
  p_identity_conf real,
  p_identity_confirmed boolean,
  p_value_low_cents int,
  p_value_high_cents int,
  p_photo_score smallint,
  p_missing_angles text[]
)
returns public.item_readiness
language sql
immutable
set search_path = ''
as $$
  select case
    when not (coalesce(p_identity_confirmed, false) or coalesce(p_identity_conf, 0) >= 0.85)
      or p_value_low_cents is null
      or p_value_high_cents is null
      or (p_value_high_cents > 1.6 * p_value_low_cents and p_value_high_cents - p_value_low_cents > 3000)
      then 'logged'::public.item_readiness
    when coalesce(p_photo_score, 0) >= 75 and coalesce(cardinality(p_missing_angles), 0) = 0
      then 'showcase'::public.item_readiness
    else 'identified'::public.item_readiness
  end;
$$;

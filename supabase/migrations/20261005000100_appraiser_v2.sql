-- Appraiser v2: progressive Items, a shared price cache, and follow-up photos.

-- 1. Items appear as soon as they are identified and are priced in place. While this is
--    true the value is still being worked out (or re-worked after new photos).
alter table public.items add column appraising boolean not null default false;

-- 2. Price research results, reused across users for the same product and condition.
--    Written and read only by the worker (service role). Holds no user data: the key is a
--    normalized product name, and the notes are about the product, not anyone's Item.
create table public.price_cache (
  -- e.g. "m:lego|21327" (brand and model) or "t:air jordan 1 mid|chicago" (title and variant).
  product_key text not null check (char_length(product_key) between 1 and 300),
  condition_grade public.condition_grade not null,
  value_low_cents int not null check (value_low_cents >= 0),
  value_mid_cents int not null check (value_mid_cents >= 0),
  value_high_cents int not null check (value_high_cents >= 0),
  confidence real not null check (confidence between 0 and 1),
  basis jsonb not null default '[]'::jsonb,
  research text not null default '' check (char_length(research) <= 8000),
  model text not null,
  prompt_version text not null,
  created_at timestamptz not null default now(),
  primary key (product_key, condition_grade),
  check (value_low_cents <= value_mid_cents and value_mid_cents <= value_high_cents)
);
create index price_cache_created_idx on public.price_cache (created_at);

alter table public.price_cache enable row level security;
-- No policies: server only. Also drop the default grants from the shim and Supabase.
revoke all on table public.price_cache from public, anon, authenticated;

-- 3. Follow-up photos. Atomically records the new photos, marks the Item appraising and
--    enqueues the Appraiser. Called by the API with the service role after it checks auth.
--    Returns null when the Item is missing, removed or someone else's. Raises object_in_use
--    (55006) when a Deal holds the Item or it is already being appraised.
create or replace function public.submit_item_media(p_user_id uuid, p_item_id uuid, p_media jsonb)
returns public.items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_prefix text := p_user_id::text || '/items/' || p_item_id::text || '/';
  v_count int := coalesce(jsonb_array_length(p_media), 0);
  v_next int;
begin
  select * into v_item from public.items
   where id = p_item_id and owner_id = p_user_id and status <> 'removed'
   for update;
  if not found then
    return null;
  end if;
  if v_item.reserved_by_deal_id is not null or v_item.status in ('reserved', 'traded') or v_item.appraising then
    raise exception 'item is reserved or already appraising' using errcode = '55006';
  end if;

  if v_count < 1 or v_count > 5 then
    raise exception 'expected 1 to 5 photos, got %', v_count using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_media) m
     where coalesce(m ->> 'path', '') = ''
        or left(m ->> 'path', length(v_prefix)) <> v_prefix
        or position('..' in m ->> 'path') > 0
  ) then
    raise exception 'media must come from this item''s uploads' using errcode = '22023';
  end if;

  select coalesce(max(position), -1) + 1 into v_next from public.item_media where item_id = p_item_id;

  insert into public.item_media (item_id, storage_path, kind, width, height, sharpness, position)
  select p_item_id,
         m ->> 'path',
         'photo',
         (m ->> 'width')::int,
         (m ->> 'height')::int,
         (m ->> 'sharpness')::real,
         v_next + (t.ordinality - 1)::int
    from jsonb_array_elements(p_media) with ordinality as t(m, ordinality);

  update public.items set appraising = true where id = p_item_id
  returning * into v_item;

  insert into public.jobs (kind, payload)
  values ('reappraise_item', jsonb_build_object('item_id', p_item_id, 'user_id', p_user_id));

  return v_item;
end;
$$;

revoke execute on function public.submit_item_media(uuid, uuid, jsonb) from public, anon, authenticated;

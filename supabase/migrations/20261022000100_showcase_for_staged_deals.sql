-- Found dogfooding on prod: a staged Deal waits for showcase photos of its Items
-- (items_promote_staged_deal promotes it once every held Item is showcase), but
-- submit_item_media refused any Item a Deal holds, so the photos the Deal asked for could
-- never arrive and every staged Deal expired. Photos are now accepted while the hold comes
-- from a staged Deal; once the Deal is out for approval, or further along, the Item stays
-- locked as before.

-- As in 20261006000100_refiner.sql, except the reservation check.
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
  if v_item.appraising or v_item.status = 'traded'
     or (v_item.reserved_by_deal_id is not null and not exists (
           select 1 from public.deals where id = v_item.reserved_by_deal_id and status = 'staged'
         )) then
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

  -- The reappraisal reads the photos themselves, so these answers are already folded.
  update public.item_questions
     set status = 'answered', answer = jsonb_build_object('media', true), answered_at = now(), folded_at = now()
   where item_id = p_item_id and kind = 'photo' and status = 'open';

  update public.items set appraising = true where id = p_item_id
  returning * into v_item;

  insert into public.jobs (kind, payload)
  values ('reappraise_item', jsonb_build_object('item_id', p_item_id, 'user_id', p_user_id));

  return v_item;
end;
$$;

revoke execute on function public.submit_item_media(uuid, uuid, jsonb) from public, anon, authenticated;

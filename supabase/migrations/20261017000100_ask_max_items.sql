-- Asks that take several Items (bundles, 20261016000100_bundles.sql): the owner and the GM
-- set asks.max_items through patch_ask, and changing it on a prospecting Ask re-matches it.

-- As in 20261008000300_asks_and_taste_facts.sql, plus max_items (1 to 5; the column's check
-- refuses anything else).
create or replace function public.patch_ask(p_user_id uuid, p_ask_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ask public.asks%rowtype;
  v_ids uuid[];
  v_valid int;
  v_status public.ask_status;
begin
  select * into v_ask from public.asks where id = p_ask_id and user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_ask.status in ('fulfilled', 'expired', 'cancelled') then
    if v_ask.status = 'cancelled' and p_patch ? 'status' and (select count(*) from jsonb_object_keys(p_patch)) = 1 then
      return jsonb_build_object('result', 'ok');
    end if;
    return jsonb_build_object('result', 'ask_closed');
  end if;

  if p_patch ? 'status' and p_patch->>'status' is distinct from 'cancelled' then
    return jsonb_build_object('result', 'invalid_status');
  end if;

  v_status := v_ask.status;

  if p_patch ? 'offer_item_ids' then
    select coalesce(array_agg(distinct x::uuid), '{}')
      into v_ids
      from jsonb_array_elements_text(p_patch->'offer_item_ids') as x;

    select count(*) into v_valid
      from (
        select i.id
          from public.items i
         where i.id = any (v_ids)
           and i.owner_id = p_user_id
           and i.status = 'on_shelf'
           and i.reserved_by_deal_id is null
         for share
      ) ok;
    if v_valid <> cardinality(v_ids) then
      return jsonb_build_object('result', 'invalid_offer_item');
    end if;

    delete from public.offer_sets where ask_id = p_ask_id and item_id <> all (v_ids);
    insert into public.offer_sets (ask_id, item_id)
    select p_ask_id, unnest(v_ids)
    on conflict do nothing;

    if cardinality(v_ids) > 0 and v_status in ('drafting', 'offering') then
      v_status := 'prospecting';
    end if;
  end if;

  if p_patch ? 'target' and v_status = 'drafting' then
    v_status := 'offering';
  end if;

  if p_patch->>'status' = 'cancelled' then
    v_status := 'cancelled';
  end if;

  update public.asks
     set raw_text = case when p_patch ? 'raw_text' then p_patch->>'raw_text' else raw_text end,
         target = case when p_patch ? 'target' then p_patch->'target' else target end,
         title = case when p_patch ? 'title' then p_patch->>'title' else title end,
         cash_ceiling_cents = case when p_patch ? 'cash_ceiling_cents'
                                   then (p_patch->>'cash_ceiling_cents')::int else cash_ceiling_cents end,
         max_items = case when p_patch ? 'max_items'
                          then (p_patch->>'max_items')::int else max_items end,
         autonomy = case when p_patch ? 'autonomy'
                         then (p_patch->>'autonomy')::public.autonomy_level else autonomy end,
         deadline = case when p_patch ? 'deadline'
                         then (p_patch->>'deadline')::timestamptz else deadline end,
         status = v_status
   where id = p_ask_id;

  return jsonb_build_object('result', 'ok');
end;
$$;

revoke execute on function public.patch_ask(uuid, uuid, jsonb) from public, anon, authenticated;

-- As in 20261010000100_prospector.sql, plus max_items: taking more Items can open new Deals.
create or replace function public.prospect_on_ask_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'prospecting' and (
       old.status is distinct from 'prospecting'
       or old.target is distinct from new.target
       or old.cash_ceiling_cents is distinct from new.cash_ceiling_cents
       or old.max_items is distinct from new.max_items
     ) then
    perform public.enqueue_prospect_ask(new.id, new.user_id);
  end if;
  return null;
end;
$$;

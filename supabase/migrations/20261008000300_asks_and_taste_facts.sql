-- Milestone 2: Ask titles, atomic Ask edits with offer set rules, and taste fact guards.
-- See docs/contracts/m2-gm-and-asks.md. RLS on asks, offer_sets and taste_facts stays owner-only.

-- Asks -------------------------------------------------------------------------

-- Set from the resolved target, e.g. "LEGO Batman Batmobile Tumbler 76240".
alter table public.asks add column title text check (title is null or char_length(title) <= 120);

-- GET /v1/asks lists newest first.
create index asks_user_created_idx on public.asks (user_id, created_at desc);
-- Which Asks offer an Item (Item removal, reservation and the matcher look this up).
create index offer_sets_item_idx on public.offer_sets (item_id);

-- Applies an owner's edit to an Ask in 1 transaction. Called by the API with the service
-- role, so it checks ownership itself. p_patch holds only the fields to change:
--   raw_text, target (jsonb), title, offer_item_ids (uuid array), cash_ceiling_cents,
--   autonomy, deadline (null clears it), status ('cancelled' is the only value accepted).
-- Rules:
--   - Someone else's Ask, or a missing one, is not_found.
--   - A fulfilled, expired or cancelled Ask is closed (cancelling a cancelled Ask is ok).
--   - Offer Items must be the owner's, on the Shelf and not reserved, or invalid_offer_item.
--     They are locked while checked, so a Deal cannot reserve them halfway through.
--   - A drafting Ask that gets a target moves to offering.
--   - A non-empty offer set on a drafting or offering Ask moves it to prospecting.
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

-- Taste facts --------------------------------------------------------------------

-- Where a fact came from; the API shows it as "Intake chat", "Chat" or "Shelf edits".
alter table public.taste_facts
  add column source text not null default 'chat' check (source in ('intake', 'chat', 'shelf_edits'));

-- Categories from the contract. Facts written before the extractor existed had 'general'.
update public.taste_facts
   set category = 'preferences'
 where category not in ('interests', 'hunting', 'limits', 'preferences', 'style');
alter table public.taste_facts alter column category set default 'preferences';
alter table public.taste_facts
  add constraint taste_facts_category_check
  check (category in ('interests', 'hunting', 'limits', 'preferences', 'style'));

-- snake_case keys.
alter table public.taste_facts
  add constraint taste_facts_key_format check (key ~ '^[a-z][a-z0-9_]{0,79}$') not valid;

-- 1 active fact per key and value. Retried extractor jobs cannot write duplicates.
create unique index taste_facts_active_key_value_idx
  on public.taste_facts (user_id, key, lower(value))
  where status = 'active';
-- The extractor checks what the user deleted, so it never writes it again.
create index taste_facts_user_key_idx on public.taste_facts (user_id, key);

-- At most 40 active facts per user, whatever writes them.
create or replace function public.check_taste_fact_cap()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'active'
     and (tg_op = 'INSERT' or old.status is distinct from 'active')
     and (select count(*) from public.taste_facts
           where user_id = new.user_id and status = 'active' and id <> new.id) >= 40 then
    raise exception 'a user has at most 40 active taste facts' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger taste_facts_cap before insert or update of status on public.taste_facts
  for each row execute function public.check_taste_fact_cap();

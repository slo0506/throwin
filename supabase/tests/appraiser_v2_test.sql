-- Appraiser v2: appraising flag, price cache and follow-up photos.
-- Runs inside a transaction that is rolled back, so later test files see the seed as is.
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data)
values ('00000000-0000-4000-8000-000000000004', 'riley@example.com', '{"first_name": "Riley"}');

insert into public.items (id, owner_id, status, title, follow_up)
values
  ('20000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000004', 'needs_photos', 'Air Jordan 1 Mid', 'Photo of the size tag'),
  ('20000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-000000000004', 'on_shelf', 'Mario Kart 8', null);
insert into public.item_media (item_id, storage_path, position)
values ('20000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000004/c/crops/0.jpg', 0);

-- 1. New Items are not appraising unless the worker says so.
do $$
begin
  if (select appraising from public.items where id = '20000000-0000-4000-8000-000000000042') then
    raise exception 'appraising should default to false';
  end if;
end $$;

-- 2. submit_item_media records photos after the existing ones, flags the Item and enqueues
--    exactly 1 reappraise_item job.
do $$
declare
  v public.items;
  jobs_before int := (select count(*) from public.jobs where kind = 'reappraise_item');
begin
  v := public.submit_item_media(
    '00000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000041',
    '[{"path": "00000000-0000-4000-8000-000000000004/items/20000000-0000-4000-8000-000000000041/a.jpg", "width": 1000, "height": 750},
      {"path": "00000000-0000-4000-8000-000000000004/items/20000000-0000-4000-8000-000000000041/b.jpg", "sharpness": 40}]'::jsonb);
  if not v.appraising then raise exception 'item not marked appraising'; end if;
  if (select array_agg(position order by position) from public.item_media
       where item_id = '20000000-0000-4000-8000-000000000041') <> array[0, 1, 2] then
    raise exception 'new photos not appended after the crop';
  end if;
  if (select count(*) from public.jobs where kind = 'reappraise_item') <> jobs_before + 1 then
    raise exception 'reappraise_item job not enqueued';
  end if;
  if not exists (select 1 from public.jobs where kind = 'reappraise_item'
                  and payload = jsonb_build_object('item_id', '20000000-0000-4000-8000-000000000041',
                                                   'user_id', '00000000-0000-4000-8000-000000000004')) then
    raise exception 'reappraise_item payload is wrong';
  end if;

  -- Already appraising: refused.
  begin
    perform public.submit_item_media('00000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000041',
      '[{"path": "00000000-0000-4000-8000-000000000004/items/20000000-0000-4000-8000-000000000041/c.jpg"}]'::jsonb);
    raise exception 'second submit while appraising was allowed';
  exception when object_in_use then null;
  end;

  -- Paths outside the Item's folder: refused, nothing written.
  begin
    perform public.submit_item_media('00000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000042',
      '[{"path": "00000000-0000-4000-8000-000000000004/items/20000000-0000-4000-8000-000000000041/x.jpg"}]'::jsonb);
    raise exception 'path from another item was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.submit_item_media('00000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000042',
      '[{"path": "00000000-0000-4000-8000-000000000004/items/20000000-0000-4000-8000-000000000042/../../x.jpg"}]'::jsonb);
    raise exception 'path traversal was accepted';
  exception when invalid_parameter_value then null;
  end;
  if (select appraising from public.items where id = '20000000-0000-4000-8000-000000000042') then
    raise exception 'refused submit still flagged the item';
  end if;

  -- Someone else's Item: invisible.
  if public.submit_item_media('00000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000042',
       '[{"path": "00000000-0000-4000-8000-000000000001/items/20000000-0000-4000-8000-000000000042/a.jpg"}]'::jsonb) is not null then
    raise exception 'submitted photos to another user''s item';
  end if;
end $$;

-- 3. A Deal out for approval locks its Item's photos; a staged Deal, which is waiting for
--    showcase photos, takes them.
insert into public.deals (id, status) values ('50000000-0000-4000-8000-000000000041', 'pending_approvals');
do $$
begin
  update public.items set status = 'reserved', reserved_by_deal_id = '50000000-0000-4000-8000-000000000041'
   where id = '20000000-0000-4000-8000-000000000042';
  perform public.submit_item_media('00000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000042',
    '[{"path": "00000000-0000-4000-8000-000000000004/items/20000000-0000-4000-8000-000000000042/a.jpg"}]'::jsonb);
  raise exception 'reserved item accepted new photos';
exception when object_in_use then null;
end $$;
do $$
begin
  -- The block above rolled back its own update when the exception was caught.
  update public.deals set status = 'staged' where id = '50000000-0000-4000-8000-000000000041';
  update public.items set status = 'reserved', reserved_by_deal_id = '50000000-0000-4000-8000-000000000041'
   where id = '20000000-0000-4000-8000-000000000042';
  if public.submit_item_media('00000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000042',
       '[{"path": "00000000-0000-4000-8000-000000000004/items/20000000-0000-4000-8000-000000000042/b.jpg"}]'::jsonb) is null then
    raise exception 'a staged Deal''s Item should take its showcase photos';
  end if;
  if (select status from public.items where id = '20000000-0000-4000-8000-000000000042') <> 'reserved'
     or (select reserved_by_deal_id from public.items where id = '20000000-0000-4000-8000-000000000042')
        <> '50000000-0000-4000-8000-000000000041' then
    raise exception 'the Item must stay held by its Deal';
  end if;
end $$;

-- 4. The price cache keeps ranges ordered and is invisible to clients.
insert into public.price_cache (product_key, condition_grade, value_low_cents, value_mid_cents, value_high_cents, confidence, model, prompt_version)
values ('m:lego|21327', 'B', 18000, 21000, 24000, 0.8, 'claude-haiku-4-5', 'test');
do $$
begin
  insert into public.price_cache (product_key, condition_grade, value_low_cents, value_mid_cents, value_high_cents, confidence, model, prompt_version)
  values ('m:bad', 'B', 300, 200, 100, 0.5, 'x', 'test');
  raise exception 'price_cache accepted an unordered range';
exception when check_violation then null;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000004';
do $$
begin
  begin
    perform 1 from public.price_cache;
    raise exception 'clients can read price_cache';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.price_cache (product_key, condition_grade, value_low_cents, value_mid_cents, value_high_cents, confidence, model, prompt_version)
    values ('m:spoof', 'A', 1, 2, 3, 1, 'x', 'x');
    raise exception 'clients can write price_cache';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.submit_item_media('00000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000041', '[]'::jsonb);
    raise exception 'clients can call submit_item_media';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;

select 'appraiser v2 tests passed' as result;

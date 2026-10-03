-- Dev seed: 2 people in the Thursday Lego Circle with a few Items each.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000001', 'jordan@example.com', '{"first_name": "Jordan"}'),
  ('00000000-0000-4000-8000-000000000002', 'maya@example.com', '{"first_name": "Maya"}')
on conflict (id) do nothing;

insert into public.circles (id, name, owner_id, category_focus) values
  ('10000000-0000-4000-8000-000000000001', 'Thursday Lego Circle', '00000000-0000-4000-8000-000000000001', '{toys/lego}')
on conflict (id) do nothing;

insert into public.circle_members (circle_id, user_id, role) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'member')
on conflict do nothing;

insert into public.invites (code, circle_id, created_by) values
  ('THURSDAY-LEGO', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001')
on conflict do nothing;

insert into public.items (id, owner_id, status, category, brand, model, title, condition_grade,
                          value_low_cents, value_mid_cents, value_high_cents, identity_conf, condition_conf) values
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'on_shelf', 'toys/lego', 'LEGO', '76240',
   'Batmobile Tumbler', 'B', 18000, 21500, 25000, 0.86, 0.62),
  ('20000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'on_shelf', 'video_games', 'Nintendo', 'Zelda TOTK',
   'Zelda: Tears of the Kingdom', 'A', 3500, 4200, 5000, 0.95, 0.9),
  ('20000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'on_shelf', 'toys/lego', 'LEGO', '10497',
   'Galaxy Explorer', 'A', 7000, 8500, 9900, 0.91, 0.8),
  ('20000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000002', 'on_shelf', 'video_games', 'Nintendo', 'Mario Wonder',
   'Super Mario Bros. Wonder', 'B', 3000, 3600, 4200, 0.93, 0.75)
on conflict (id) do nothing;

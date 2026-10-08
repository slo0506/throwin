-- Photos are a promise about the owner's own Item (docs/specs/trust-and-verification.md).
-- The Refiner now flags 3 more problems: a photo of something else (wrong_item), a photo that
-- looks like a store or stock image (stock_photo), and the same shot twice (duplicate_photo).
-- Those photos don't count toward the score or the showcase angles.
alter table public.items drop constraint if exists items_photo_issues_check;
alter table public.items add constraint items_photo_issues_check check (
  photo_issues <@ array[
    'too_small', 'blurry', 'dark', 'cut_off', 'cluttered_background', 'missing_angles',
    'wrong_item', 'stock_photo', 'duplicate_photo'
  ]::text[]
);

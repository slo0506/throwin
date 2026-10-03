-- Tighten function grants (Supabase security advisor).
-- Trigger functions are never called directly. RLS helpers are for signed-in users only.

revoke execute on function public.handle_new_auth_user() from public, anon, authenticated;
revoke execute on function public.handle_new_circle() from public, anon, authenticated;

revoke execute on function public.is_circle_member(uuid) from public, anon;
revoke execute on function public.shares_circle_with(uuid) from public, anon;
revoke execute on function public.is_deal_participant(uuid) from public, anon;
grant execute on function public.is_circle_member(uuid) to authenticated;
grant execute on function public.shares_circle_with(uuid) to authenticated;
grant execute on function public.is_deal_participant(uuid) to authenticated;

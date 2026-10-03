-- Milestone 3: joining Circles through invite codes. See docs/contracts/m3-circles.md.
-- Creating a Circle and listing members need no new SQL: the API writes with the service
-- role, and on_circle_created already makes the owner a member.

-- Redeems an invite for p_user_id in 1 transaction. Called by the API with the service
-- role, so it checks everything itself. Returns { result, circle_id }:
--   ok              joined (uses goes up by 1)
--   already_member  nothing changes and uses stays the same, so retries are free
--   not_found       no such code, or its Circle is paused
--   expired         past expires_at
--   full            uses reached max_uses
-- The invite row is locked first, so 2 people redeeming the last use can't both get in.
create or replace function public.accept_invite(p_user_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite public.invites%rowtype;
begin
  select i.* into v_invite
    from public.invites i
    join public.circles c on c.id = i.circle_id and c.status = 'active'
   where i.code = p_code
     for update of i;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if exists (
    select 1 from public.circle_members
     where circle_id = v_invite.circle_id and user_id = p_user_id
  ) then
    return jsonb_build_object('result', 'already_member', 'circle_id', v_invite.circle_id);
  end if;

  if v_invite.expires_at <= now() then
    return jsonb_build_object('result', 'expired', 'circle_id', v_invite.circle_id);
  end if;
  if v_invite.uses >= v_invite.max_uses then
    return jsonb_build_object('result', 'full', 'circle_id', v_invite.circle_id);
  end if;

  insert into public.circle_members (circle_id, user_id, role)
  values (v_invite.circle_id, p_user_id, 'member');
  update public.invites set uses = uses + 1 where code = p_code;

  return jsonb_build_object('result', 'ok', 'circle_id', v_invite.circle_id);
end;
$$;

revoke execute on function public.accept_invite(uuid, text) from public, anon, authenticated;

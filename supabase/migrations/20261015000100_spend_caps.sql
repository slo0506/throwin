-- Spend caps (docs/setup.md, "Spend caps"). Every model call is recorded in agent_runs with
-- its cost. Before spending more, the workers and the GM read what they spent in the last
-- day and stop at their budget, so nothing that runs on its own can run up a bill.

create index agent_runs_created_idx on public.agent_runs (created_at desc);

-- Model spend in cents since p_since. p_user narrows it to 1 person; p_gm to GM chat (true)
-- or the background agents (false). Server only.
create or replace function public.model_spend_cents(
  p_since timestamptz,
  p_user uuid default null,
  p_gm boolean default null
)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(cost_cents), 0)
    from public.agent_runs
   where created_at >= p_since
     and (p_user is null or user_id = p_user)
     and (p_gm is null or (agent = 'gm') = p_gm);
$$;

revoke execute on function public.model_spend_cents(timestamptz, uuid, boolean) from public, anon, authenticated;

-- Found dogfooding on prod, right after Deals started going out at identified: a staged
-- Deal asks its owner for quick answers ("3 quick answers and the deal can go out"), but
-- answer_item_question refused any Item a Deal holds ("Couldn't save that answer"). Like
-- 20261022000100 did for photos, answers are accepted while the hold comes from a staged Deal.

-- As in 20261006000100_refiner.sql, except the reservation check.
create or replace function public.answer_item_question(p_user_id uuid, p_question_id uuid, p_answer text, p_skip boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_question public.item_questions;
  v_item public.items;
  v_answer text := btrim(coalesce(p_answer, ''));
begin
  select q.* into v_question
    from public.item_questions q
    join public.items i on i.id = q.item_id
   where q.id = p_question_id and i.owner_id = p_user_id and i.status <> 'removed'
   for update of q;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  select * into v_item from public.items where id = v_question.item_id for update;

  if v_question.status <> 'open' then
    return jsonb_build_object('result', 'already_answered', 'item_id', v_item.id);
  end if;
  -- A staged Deal is waiting for exactly these answers (pin_down_item), so its hold doesn't
  -- block them. Out for approval or further along, the Item stays locked.
  if v_item.status = 'traded'
     or (v_item.reserved_by_deal_id is not null and not exists (
           select 1 from public.deals where id = v_item.reserved_by_deal_id and status = 'staged'
         )) then
    return jsonb_build_object('result', 'item_reserved', 'item_id', v_item.id);
  end if;

  if not coalesce(p_skip, false) then
    if v_question.kind = 'photo' then
      return jsonb_build_object('result', 'use_media_upload', 'item_id', v_item.id);
    end if;
    if (v_question.kind in ('yes_no', 'choice', 'picker') and not (v_question.options ? v_answer))
       or (v_question.kind = 'text' and char_length(v_answer) not between 1 and 200) then
      return jsonb_build_object('result', 'invalid_answer', 'item_id', v_item.id);
    end if;
    update public.item_questions
       set status = 'answered', answer = jsonb_build_object('value', v_answer), answered_at = now()
     where id = p_question_id;
  else
    update public.item_questions
       set status = 'skipped', skip_count = skip_count + 1, answered_at = now()
     where id = p_question_id;
  end if;

  update public.items set appraising = true where id = v_item.id;
  perform public.enqueue_refine_item(v_item.id, p_user_id, 'answer');
  return jsonb_build_object('result', 'ok', 'item_id', v_item.id);
end;
$$;

revoke execute on function public.answer_item_question(uuid, uuid, text, boolean) from public, anon, authenticated;

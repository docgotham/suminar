-- B2-solo: server-assigned sequences. Hosts stop computing event positions;
-- this function is the single writer of the head. It locks the conversation
-- row (lock before check — the Mem·Sum race lesson), assigns sequences at
-- the current head, inserts the batch, and bumps last_sequence in one
-- transaction, so concurrent host threads can never collide on a position
-- and last_sequence can never regress. Owner-checked; service-role only.

create or replace function public.append_conversation_events(
  p_token text,
  p_owner uuid,
  p_events jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_head integer;
  v_event jsonb;
  v_seq integer;
begin
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) = 0 then
    raise exception 'append_conversation_events requires a non-empty jsonb array';
  end if;
  if jsonb_array_length(p_events) > 500 then
    raise exception 'append_conversation_events accepts at most 500 events per call';
  end if;

  select last_sequence into v_head
  from public.conversations
  where token = p_token and owner = p_owner
  for update;
  if not found then
    raise exception 'Unknown or expired Suminar conversation token';
  end if;

  v_seq := v_head;
  for v_event in select * from jsonb_array_elements(p_events) loop
    v_seq := v_seq + 1;
    insert into public.conversation_events (conversation_token, sequence, event)
    values (p_token, v_seq, jsonb_set(v_event, '{sequence}', to_jsonb(v_seq)));
  end loop;

  update public.conversations
  set last_sequence = v_seq
  where token = p_token and owner = p_owner;

  return jsonb_build_object('start', v_head + 1, 'end', v_seq, 'last_sequence', v_seq);
end $$;

revoke execute on function public.append_conversation_events(text, uuid, jsonb) from public;
revoke execute on function public.append_conversation_events(text, uuid, jsonb) from anon;
revoke execute on function public.append_conversation_events(text, uuid, jsonb) from authenticated;
grant execute on function public.append_conversation_events(text, uuid, jsonb) to service_role;

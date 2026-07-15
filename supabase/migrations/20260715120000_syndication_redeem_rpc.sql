-- Serialize syndication redemption. The hosted handler previously checked
-- use_count, inserted the grant, and incremented in three unlocked steps, so
-- two recipients redeeming the same code in the same instant could overshoot
-- the cap by one (1.0 pre-launch review finding — a cap overshoot, never an
-- access grant beyond the code's holders). This RPC copies the invite path's
-- pattern: one service-role function, SELECT ... FOR UPDATE on the code row,
-- validate, insert, increment — one transaction, no race. The grant-cap
-- trigger and the active-pair unique index still fire inside it; either
-- rolls back the whole redemption including the increment.

create or replace function public.redeem_syndication_code(
  p_code_hash text,
  p_grantee_user_id uuid,
  p_local_handle text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_code public.agent_syndication_codes%rowtype;
  v_grant_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Suminar redeem_syndication_code is service-role only';
  end if;
  if p_local_handle is null or length(btrim(p_local_handle)) < 1 then
    raise exception 'redeem_syndication_code requires a local handle';
  end if;

  select * into v_code from public.agent_syndication_codes
  where code_hash = lower(coalesce(p_code_hash, ''))
  for update;

  if v_code.id is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_or_expired');
  end if;
  if v_code.revoked_at is not null or v_code.expires_at <= now() or v_code.use_count >= v_code.max_uses then
    return jsonb_build_object('ok', false, 'reason', 'unknown_or_expired');
  end if;
  if v_code.grantor_user_id = p_grantee_user_id then
    return jsonb_build_object('ok', false, 'reason', 'own_agent');
  end if;
  if exists (
    select 1 from public.agent_syndication_grants
    where agent_id = v_code.agent_id
      and grantee_user_id = p_grantee_user_id
      and revoked_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'already_granted');
  end if;

  insert into public.agent_syndication_grants (agent_id, grantor_user_id, grantee_user_id, code_id, local_handle)
  values (v_code.agent_id, v_code.grantor_user_id, p_grantee_user_id, v_code.id, btrim(p_local_handle))
  returning id into v_grant_id;

  update public.agent_syndication_codes
  set use_count = use_count + 1
  where id = v_code.id;

  return jsonb_build_object(
    'ok', true,
    'grantId', v_grant_id,
    'agentId', v_code.agent_id,
    'grantorUserId', v_code.grantor_user_id
  );
end;
$$;

revoke all on function public.redeem_syndication_code(text, uuid, text) from public, anon, authenticated;
grant execute on function public.redeem_syndication_code(text, uuid, text) to service_role;

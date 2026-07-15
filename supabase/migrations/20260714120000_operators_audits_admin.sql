-- The operator surface, under the family doctrine: the operator sees
-- aggregates and account metadata, never what anyone uploaded, asked, or was
-- told — by construction. This migration deliberately references no column
-- that carries user material, and a kernel test scans every migration
-- defining admin_overview so a future redefinition cannot quietly widen it.
--
-- operator_access_audits is the standing commitment behind that doctrine: if
-- operator tooling ever touches an account's material (support, incident), it
-- must write a row here — and the account's owner can read it. If we ever
-- look, you see that we looked.

create table if not exists public.operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.operators enable row level security;
revoke all on table public.operators from public, anon, authenticated;
grant all on table public.operators to service_role;

insert into public.operators (user_id)
values ('0920def0-fcaa-4d65-a270-b821cb126297')
on conflict (user_id) do nothing;

-- Resolves the acting operator in both calling shapes: an authenticated
-- session (auth.uid()) or the hosted layer acting service-role on behalf of a
-- bearer-resolved account (p_actor).
create or replace function public.require_operator(p_actor uuid default null)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_actor uuid;
begin
  if auth.role() = 'service_role' then
    v_actor := p_actor;
  else
    v_actor := auth.uid();
  end if;
  if v_actor is null or not exists (select 1 from public.operators where user_id = v_actor) then
    raise exception 'Suminar operator access required';
  end if;
  return v_actor;
end;
$$;

revoke all on function public.require_operator(uuid) from public, anon;
grant execute on function public.require_operator(uuid) to authenticated;
grant execute on function public.require_operator(uuid) to service_role;

-- Audit rows readable by the audited ---------------------------------------

create table if not exists public.export_audits (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  document_id uuid,
  scope text not null check (scope in ('bundle', 'original')),
  created_at timestamptz not null default now()
);
create index if not exists export_audits_owner_idx
  on public.export_audits (owner, created_at desc);

alter table public.export_audits enable row level security;
drop policy if exists export_audits_owner_read on public.export_audits;
create policy export_audits_owner_read on public.export_audits
  for select to authenticated using (owner = auth.uid());
revoke all on table public.export_audits from public, anon;
grant select on table public.export_audits to authenticated;
grant all on table public.export_audits to service_role;

create table if not exists public.operator_access_audits (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  operator_user_id uuid references auth.users(id) on delete set null,
  reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists operator_access_audits_owner_idx
  on public.operator_access_audits (owner, created_at desc);

alter table public.operator_access_audits enable row level security;
drop policy if exists operator_access_audits_owner_read on public.operator_access_audits;
create policy operator_access_audits_owner_read on public.operator_access_audits
  for select to authenticated using (owner = auth.uid());
revoke all on table public.operator_access_audits from public, anon;
grant select on table public.operator_access_audits to authenticated;
grant all on table public.operator_access_audits to service_role;

-- The overview: aggregates and per-account usage metadata only ---------------

create or replace function public.admin_overview(p_operator uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_accounts jsonb;
  v_waitlist jsonb;
  v_invites jsonb;
  v_daily jsonb;
  v_totals jsonb;
begin
  perform public.require_operator(p_operator);

  select coalesce(jsonb_agg(account order by account -> 'createdAt' desc), '[]'::jsonb) into v_accounts
  from (
    select jsonb_build_object(
      'email', u.email,
      'createdAt', u.created_at,
      'lastSignInAt', u.last_sign_in_at,
      'documentCount', (select count(*) from public.documents d where d.owner = u.id),
      'agentCount', (select count(*) from public.source_agents sa where sa.owner = u.id),
      'conversationCount', (select count(*) from public.conversations c where c.owner = u.id),
      'storageBytes', coalesce((select sum(d.byte_size) from public.documents d where d.owner = u.id), 0),
      'invocations24h', (select count(*) from public.invocation_usage iu where iu.owner = u.id and iu.created_at > now() - interval '24 hours'),
      'invocations30d', (select count(*) from public.invocation_usage iu where iu.owner = u.id and iu.created_at > now() - interval '30 days')
    ) as account
    from auth.users u
  ) accounts;

  select coalesce(jsonb_agg(entry order by entry -> 'createdAt' desc), '[]'::jsonb) into v_waitlist
  from (
    select jsonb_build_object(
      'email', w.email,
      'createdAt', w.created_at,
      'invitedAt', w.invited_at
    ) as entry
    from public.waitlist w
  ) waitlist_entries;

  select coalesce(jsonb_agg(invite order by invite -> 'createdAt' desc), '[]'::jsonb) into v_invites
  from (
    select jsonb_build_object(
      'issuerEmail', u.email,
      'note', ic.note,
      'maxUses', ic.max_uses,
      'useCount', ic.use_count,
      'expiresAt', ic.expires_at,
      'revokedAt', ic.revoked_at,
      'createdAt', ic.created_at
    ) as invite
    from public.invite_codes ic
    left join auth.users u on u.id = ic.issuer_user_id
  ) invites;

  select coalesce(jsonb_agg(day_row order by day_row -> 'day' desc), '[]'::jsonb) into v_daily
  from (
    select jsonb_build_object(
      'day', to_char(d.day, 'YYYY-MM-DD'),
      'newAccounts', (select count(*) from auth.users u where u.created_at::date = d.day),
      'invocations', (select count(*) from public.invocation_usage iu where iu.created_at::date = d.day),
      'documentsAdded', (select count(*) from public.documents x where x.created_at::date = d.day)
    ) as day_row
    from (select generate_series(current_date - interval '13 days', current_date, interval '1 day')::date as day) d
  ) daily;

  select jsonb_build_object(
    'accounts', (select count(*) from auth.users),
    'documents', (select count(*) from public.documents),
    'agents', (select count(*) from public.source_agents),
    'conversations', (select count(*) from public.conversations),
    'waitlist', (select count(*) from public.waitlist),
    'invocations24h', (select count(*) from public.invocation_usage where created_at > now() - interval '24 hours'),
    'invocations30d', (select count(*) from public.invocation_usage where created_at > now() - interval '30 days'),
    'storageBytes', coalesce((select sum(byte_size) from public.documents), 0),
    'activeAccounts7d', (select count(distinct owner) from public.invocation_usage where created_at > now() - interval '7 days')
  ) into v_totals;

  return jsonb_build_object(
    'totals', v_totals,
    'accounts', v_accounts,
    'waitlist', v_waitlist,
    'inviteCodes', v_invites,
    'daily', v_daily
  );
end;
$$;

revoke all on function public.admin_overview(uuid) from public, anon;
grant execute on function public.admin_overview(uuid) to authenticated;
grant execute on function public.admin_overview(uuid) to service_role;

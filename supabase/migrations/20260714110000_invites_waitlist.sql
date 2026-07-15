-- The invite-beta doors. A public waitlist (the future site's one anonymous
-- write: a normalized email, a timestamp, nothing else — and it answers
-- identically for new and already-known addresses, so an anonymous caller
-- cannot probe who is on the list). Invite codes are hash-at-rest like
-- connector tokens: the plain code exists only in the moment of issuance,
-- accounts issue their own codes under RLS, and redemption is a service-role
-- act performed by the hosted layer at signup.

-- Waitlist ---------------------------------------------------------------

create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now(),
  invited_at timestamptz
);

alter table public.waitlist enable row level security;
revoke all on table public.waitlist from public, anon, authenticated;
grant all on table public.waitlist to service_role;

create or replace function public.join_waitlist(p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_email text;
  v_cap integer := (public.pilot_limits() ->> 'waitlistMaxEntries')::integer;
begin
  v_email := lower(btrim(coalesce(p_email, '')));
  if length(v_email) < 6 or length(v_email) > 320
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'That does not look like an email address.';
  end if;
  if (select count(*) from public.waitlist) >= v_cap then
    raise exception 'The waitlist is full right now. Please try again later.';
  end if;
  insert into public.waitlist (email) values (v_email)
  on conflict (email) do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.join_waitlist(text) from public;
grant execute on function public.join_waitlist(text) to anon;
grant execute on function public.join_waitlist(text) to authenticated;
grant execute on function public.join_waitlist(text) to service_role;

-- Invite codes -------------------------------------------------------------

create table if not exists public.invite_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),
  issuer_user_id uuid references auth.users(id) on delete set null,
  note text,
  max_uses integer not null default 1 check (max_uses between 1 and 100),
  use_count integer not null default 0 check (use_count >= 0 and use_count <= max_uses),
  expires_at timestamptz not null default now() + interval '30 days',
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists invite_codes_issuer_idx on public.invite_codes (issuer_user_id);

-- Who redeemed which code is operator bookkeeping; issuers see use counts on
-- their own codes, not identities.
create table if not exists public.invite_redemptions (
  id uuid primary key default gen_random_uuid(),
  invite_code_id uuid not null references public.invite_codes(id) on delete cascade,
  redeemed_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.invite_codes enable row level security;
alter table public.invite_redemptions enable row level security;

drop policy if exists invite_codes_issuer on public.invite_codes;
create policy invite_codes_issuer on public.invite_codes
  for all to authenticated
  using (issuer_user_id = auth.uid()) with check (issuer_user_id = auth.uid());

revoke all on table public.invite_codes from public, anon;
grant select, insert, update on table public.invite_codes to authenticated;
grant all on table public.invite_codes to service_role;
revoke all on table public.invite_redemptions from public, anon, authenticated;
grant all on table public.invite_redemptions to service_role;

-- A runaway issuer is the target; friends inviting friends is the point.
create or replace function public.enforce_invite_code_pilot_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := (public.pilot_limits() ->> 'activeInviteCodesPerIssuer')::integer;
begin
  if new.issuer_user_id is not null
    and (select count(*) from public.invite_codes
         where issuer_user_id = new.issuer_user_id
           and revoked_at is null
           and expires_at > now()
           and use_count < max_uses) >= v_limit then
    raise exception 'Suminar pilot limit: the invite beta allows % active invite codes per account', v_limit;
  end if;
  return new;
end;
$$;

drop trigger if exists invite_codes_pilot_limit on public.invite_codes;
create trigger invite_codes_pilot_limit
  before insert on public.invite_codes
  for each row execute function public.enforce_invite_code_pilot_limit();

create or replace function public.issue_invite_code(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_code_hash text := lower(payload ->> 'codeHash');
  v_note text := nullif(trim(coalesce(payload ->> 'note', '')), '');
  v_max_uses integer := coalesce((payload ->> 'maxUses')::integer, 1);
  v_days integer := coalesce((payload ->> 'expiresInDays')::integer, 30);
  v_id uuid;
begin
  if v_user_id is null then raise exception 'Suminar issue_invite_code requires an authenticated user'; end if;
  if v_code_hash is null or v_code_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invite code hash must be a lowercase SHA-256 hex digest';
  end if;
  if v_days < 1 or v_days > 365 then
    raise exception 'Invite codes expire between 1 and 365 days out';
  end if;
  insert into public.invite_codes (code_hash, issuer_user_id, note, max_uses, expires_at)
  values (v_code_hash, v_user_id, v_note, v_max_uses, now() + make_interval(days => v_days))
  returning id into v_id;
  return jsonb_build_object('inviteCodeId', v_id);
end;
$$;

revoke all on function public.issue_invite_code(jsonb) from public, anon;
grant execute on function public.issue_invite_code(jsonb) to authenticated;
grant execute on function public.issue_invite_code(jsonb) to service_role;

-- Redemption happens inside the hosted signup path, after the account exists.
create or replace function public.redeem_invite_code(p_code_hash text, p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_code public.invite_codes%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Suminar redeem_invite_code is service-role only';
  end if;
  select * into v_code from public.invite_codes
  where code_hash = lower(coalesce(p_code_hash, ''))
    and revoked_at is null
    and expires_at > now()
  for update;
  if v_code.id is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_or_expired');
  end if;
  if v_code.use_count >= v_code.max_uses then
    return jsonb_build_object('ok', false, 'reason', 'exhausted');
  end if;
  update public.invite_codes set use_count = use_count + 1 where id = v_code.id;
  insert into public.invite_redemptions (invite_code_id, redeemed_user_id)
  values (v_code.id, p_user_id);
  return jsonb_build_object('ok', true, 'inviteCodeId', v_code.id);
end;
$$;

revoke all on function public.redeem_invite_code(text, uuid) from public, anon, authenticated;
grant execute on function public.redeem_invite_code(text, uuid) to service_role;

-- The future signup form's validity check, mediated by the hosted layer:
-- a boolean, never code metadata.
create or replace function public.preview_invite_code(p_code_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Suminar preview_invite_code is service-role only';
  end if;
  return jsonb_build_object('valid', exists (
    select 1 from public.invite_codes
    where code_hash = lower(coalesce(p_code_hash, ''))
      and revoked_at is null
      and expires_at > now()
      and use_count < max_uses
  ));
end;
$$;

revoke all on function public.preview_invite_code(text) from public, anon, authenticated;
grant execute on function public.preview_invite_code(text) to service_role;

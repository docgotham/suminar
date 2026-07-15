-- Syndication: reference-with-revocation sharing of source agents inside one
-- hosted instance. Custody never moves — a grant lets another account's
-- conversations address the agent while every artifact stays in the
-- grantor's storage; exports remain owner-only by construction because the
-- recipient's account stores nothing. Codes are hash-at-rest like invite
-- codes, shown once at minting. Either side may end a grant.

create or replace function public.pilot_limits()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'invocationsPerAccountPerDay', 200,
    'invocationsPerAccountPerMonth', 2000,
    'storageBytesPerAccount', 1073741824,
    'documentsPerAccount', 50,
    'uploadMaxBytes', 268435456,
    'activeInviteCodesPerIssuer', 10,
    'waitlistMaxEntries', 10000,
    'activeSyndicationCodesPerGrantor', 10,
    'activeSyndicationGrantsPerAgent', 25
  );
$$;

create table if not exists public.agent_syndication_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),
  agent_id text not null references public.source_agents(agent_id) on delete cascade,
  grantor_user_id uuid not null references auth.users(id) on delete cascade,
  max_uses integer not null default 1 check (max_uses between 1 and 100),
  use_count integer not null default 0 check (use_count >= 0 and use_count <= max_uses),
  expires_at timestamptz not null default now() + interval '30 days',
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists syndication_codes_grantor_idx on public.agent_syndication_codes (grantor_user_id);

create table if not exists public.agent_syndication_grants (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references public.source_agents(agent_id) on delete cascade,
  grantor_user_id uuid not null references auth.users(id) on delete cascade,
  grantee_user_id uuid not null references auth.users(id) on delete cascade,
  code_id uuid references public.agent_syndication_codes(id) on delete set null,
  local_handle text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
-- One active grant per agent-and-recipient; a revoked grant does not block a
-- fresh redemption later.
create unique index if not exists syndication_grants_active_pair
  on public.agent_syndication_grants (agent_id, grantee_user_id) where revoked_at is null;
create index if not exists syndication_grants_grantee_idx
  on public.agent_syndication_grants (grantee_user_id) where revoked_at is null;

alter table public.agent_syndication_codes enable row level security;
alter table public.agent_syndication_grants enable row level security;
revoke all on table public.agent_syndication_codes from public, anon, authenticated;
revoke all on table public.agent_syndication_grants from public, anon, authenticated;
grant all on table public.agent_syndication_codes to service_role;
grant all on table public.agent_syndication_grants to service_role;

-- A runaway sharer, not a scholar circulating a source, is the target.
create or replace function public.enforce_syndication_code_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := (public.pilot_limits() ->> 'activeSyndicationCodesPerGrantor')::integer;
begin
  if (select count(*) from public.agent_syndication_codes
      where grantor_user_id = new.grantor_user_id
        and revoked_at is null
        and expires_at > now()
        and use_count < max_uses) >= v_limit then
    raise exception 'Suminar pilot limit: the invite beta allows % active syndication codes per account', v_limit;
  end if;
  return new;
end;
$$;
drop trigger if exists syndication_codes_limit on public.agent_syndication_codes;
create trigger syndication_codes_limit
  before insert on public.agent_syndication_codes
  for each row execute function public.enforce_syndication_code_limit();

create or replace function public.enforce_syndication_grant_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := (public.pilot_limits() ->> 'activeSyndicationGrantsPerAgent')::integer;
begin
  if (select count(*) from public.agent_syndication_grants
      where agent_id = new.agent_id and revoked_at is null) >= v_limit then
    raise exception 'Suminar pilot limit: the invite beta allows % active syndication grants per source agent', v_limit;
  end if;
  return new;
end;
$$;
drop trigger if exists syndication_grants_limit on public.agent_syndication_grants;
create trigger syndication_grants_limit
  before insert on public.agent_syndication_grants
  for each row execute function public.enforce_syndication_grant_limit();

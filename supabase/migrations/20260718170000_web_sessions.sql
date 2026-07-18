-- Password sign-in as a first-class door. A web session is a short-lived
-- bearer for the account pages, minted by email+password: hash-at-rest,
-- 12-hour expiry, revocable. Deliberately its own table — the OAuth
-- access-token table requires a registered client and refresh pair, and a
-- connector token is a long-lived credential; a login session is neither.
-- Service-role only, like resume codes and grants.

create table if not exists public.web_sessions (
  id uuid primary key default gen_random_uuid(),
  session_hash text not null unique check (session_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '12 hours',
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists web_sessions_user_idx on public.web_sessions (user_id, created_at desc);

alter table public.web_sessions enable row level security;
grant all on table public.web_sessions to service_role;

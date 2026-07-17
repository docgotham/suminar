-- A2: grant-based continuation credentials. A conversation's raw token is
-- its primary key and can never rotate; handing it to every host thread
-- (increment A resume) made serial custody user discipline. Grants give
-- each host thread its own revocable credential that resolves to the
-- conversation at the MCP boundary: new conversations hand their first
-- host a grant at birth, resume redemption mints one instead of returning
-- the raw token, and revoking a grant disconnects that host thread without
-- touching the record. Additive: existing raw tokens keep working.
-- Hash-at-rest like resume codes; service-role only.

create table if not exists public.conversation_grants (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  conversation_token text not null references public.conversations(token) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  label text not null default 'Connected host' check (char_length(label) <= 80),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists conversation_grants_conversation_idx
  on public.conversation_grants (conversation_token, created_at);
create index if not exists conversation_grants_owner_idx
  on public.conversation_grants (owner, created_at desc);

alter table public.conversation_grants enable row level security;
grant all on table public.conversation_grants to service_role;

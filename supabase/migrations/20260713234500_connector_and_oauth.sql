-- Connector tokens (pilot credential, hash-only at rest) and the OAuth bridge
-- for remote MCP clients (Claude, ChatGPT). Mirrors the shipped Mem·Sum
-- shapes: clients register dynamically, authorization codes are PKCE S256,
-- access/refresh tokens are stored as SHA-256 hashes, and every OAuth table
-- is service-role-only.

create table if not exists public.connector_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] not null default array['mcp'],
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  unique (token_hash)
);
create index if not exists connector_tokens_owner_idx on public.connector_tokens (owner_user_id);
create index if not exists connector_tokens_active_hash_idx on public.connector_tokens (token_hash) where revoked_at is null;

alter table public.connector_tokens enable row level security;
drop policy if exists connector_tokens_owner on public.connector_tokens;
create policy connector_tokens_owner on public.connector_tokens
  for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

create or replace function public.issue_connector_token(payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_token_id uuid;
  v_name text := nullif(trim(payload ->> 'name'), '');
  v_token_hash text := lower(payload ->> 'tokenHash');
begin
  if v_user_id is null then raise exception 'Suminar issue_connector_token requires an authenticated user'; end if;
  if v_name is null then raise exception 'Connector token name is required'; end if;
  if v_token_hash is null or v_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Connector token hash must be a lowercase SHA-256 hex digest';
  end if;
  insert into public.connector_tokens (owner_user_id, name, token_hash)
  values (v_user_id, v_name, v_token_hash)
  returning id into v_token_id;
  return jsonb_build_object('tokenId', v_token_id, 'name', v_name);
end $$;

create or replace function public.resolve_connector_token(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_token public.connector_tokens%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Suminar resolve_connector_token is service-role only';
  end if;
  select * into v_token from public.connector_tokens
  where token_hash = lower(p_token_hash)
    and revoked_at is null
    and (expires_at is null or expires_at > now());
  if v_token.id is null then return jsonb_build_object('ok', false); end if;
  update public.connector_tokens set last_used_at = now() where id = v_token.id;
  return jsonb_build_object('ok', true, 'tokenId', v_token.id, 'userId', v_token.owner_user_id, 'scopes', v_token.scopes);
end $$;

-- OAuth bridge ---------------------------------------------------------------

create table if not exists public.oauth_clients (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  client_secret_hash text check (client_secret_hash is null or client_secret_hash ~ '^[a-f0-9]{64}$'),
  client_name text not null default 'OAuth client',
  redirect_uris text[] not null,
  grant_types text[] not null default array['authorization_code', 'refresh_token'],
  response_types text[] not null default array['code'],
  token_endpoint_auth_method text not null default 'client_secret_post',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (array_length(redirect_uris, 1) is not null)
);

create table if not exists public.oauth_authorization_codes (
  code_hash text primary key check (code_hash ~ '^[a-f0-9]{64}$'),
  client_id text not null references public.oauth_clients(client_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  redirect_uri text not null,
  resource text not null,
  scope text,
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  expires_at timestamptz not null default now() + interval '5 minutes',
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists oauth_codes_client_idx on public.oauth_authorization_codes (client_id);
create index if not exists oauth_codes_expires_idx on public.oauth_authorization_codes (expires_at);

create table if not exists public.oauth_access_tokens (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  refresh_token_hash text not null unique check (refresh_token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null references public.oauth_clients(client_id) on delete cascade,
  resource text not null,
  scope text,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists oauth_tokens_user_idx on public.oauth_access_tokens (user_id);
create index if not exists oauth_tokens_active_idx on public.oauth_access_tokens (token_hash, access_expires_at) where revoked_at is null;

alter table public.oauth_clients enable row level security;
alter table public.oauth_authorization_codes enable row level security;
alter table public.oauth_access_tokens enable row level security;

revoke all on table public.oauth_clients from public, anon, authenticated;
revoke all on table public.oauth_authorization_codes from public, anon, authenticated;
revoke all on table public.oauth_access_tokens from public, anon, authenticated;
revoke execute on function public.issue_connector_token(jsonb) from public;
revoke execute on function public.resolve_connector_token(text) from public;

grant usage on schema public to authenticated, service_role;
grant select, insert, update on table public.connector_tokens to authenticated;
grant execute on function public.issue_connector_token(jsonb) to authenticated;
grant all on table public.connector_tokens to service_role;
grant all on table public.oauth_clients to service_role;
grant all on table public.oauth_authorization_codes to service_role;
grant all on table public.oauth_access_tokens to service_role;
grant execute on function public.resolve_connector_token(text) to service_role;

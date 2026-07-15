-- Suminar hosted foundation: multi-tenant accounts, documents, source agents,
-- artifacts, and the append-only conversation event streams.
-- Supabase Auth provides auth.users and auth.uid(). RLS is the isolation wall
-- for authenticated clients; the hosted layer runs service-role but scopes
-- every query by the account resolved from the bearer token.

create extension if not exists pgcrypto;

do $$ begin
  create type public.document_status as enum ('uploaded', 'processing', 'ready', 'needs_ocr_review', 'failed');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.artifact_kind as enum ('original', 'markdown', 'chunks', 'embeddings', 'extraction_report', 'private_key');
exception when duplicate_object then null;
end $$;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- Accounts ------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Reader',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Documents (the upload/management page reads this table) --------------------

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  filename text not null,
  mime text not null check (mime in (
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )),
  byte_size bigint not null check (byte_size > 0),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  storage_key text not null,
  status public.document_status not null default 'uploaded',
  failure_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists documents_owner_idx on public.documents(owner, created_at desc);

-- Source agents (LocalAgentManifest minus filesystem paths) -------------------

create table if not exists public.source_agents (
  agent_id text primary key check (agent_id ~ '^agent_[a-f0-9]{8,}$'),
  owner uuid not null references auth.users(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  card jsonb not null,
  card_digest text not null check (card_digest ~ '^[a-f0-9]{64}$'),
  extraction_status text not null check (extraction_status in ('clean', 'partial_needs_ocr_review', 'needs_ocr', 'failed')),
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists source_agents_owner_idx on public.source_agents(owner, created_at desc);

-- Artifact references are opaque storage keys, never filesystem paths.
create table if not exists public.agent_artifacts (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references public.source_agents(agent_id) on delete cascade,
  kind public.artifact_kind not null,
  storage_key text not null,
  byte_size bigint,
  sha256 text check (sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique (agent_id, kind)
);

-- Conversations (one opaque token per host thread; events are the state) ------

create table if not exists public.conversations (
  token text primary key check (token ~ '^conv_[a-zA-Z0-9_-]{40,}$'),
  owner uuid not null references auth.users(id) on delete cascade,
  input_fidelity_policy text not null default 'best_effort' check (input_fidelity_policy in ('best_effort', 'strict')),
  last_sequence integer not null default 0 check (last_sequence >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists conversations_owner_idx on public.conversations(owner, updated_at desc);

create table if not exists public.conversation_agents (
  conversation_token text not null references public.conversations(token) on delete cascade,
  agent_id text not null,
  agent_ref jsonb not null,
  joined_at_sequence integer not null default 0,
  last_delivered_sequence integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (conversation_token, agent_id)
);

create table if not exists public.conversation_events (
  conversation_token text not null references public.conversations(token) on delete cascade,
  sequence integer not null check (sequence >= 1),
  event jsonb not null,
  created_at timestamptz not null default now(),
  primary key (conversation_token, sequence)
);

-- Conversation events are append-only for every role, including service_role.
create or replace function public.forbid_event_update()
returns trigger language plpgsql as $$
begin
  raise exception 'conversation events are append-only';
end $$;

drop trigger if exists conversation_events_append_only on public.conversation_events;
create trigger conversation_events_append_only
  before update on public.conversation_events
  for each row execute function public.forbid_event_update();

-- updated_at maintenance ------------------------------------------------------

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
drop trigger if exists documents_updated_at on public.documents;
create trigger documents_updated_at before update on public.documents
  for each row execute function public.set_updated_at();
drop trigger if exists source_agents_updated_at on public.source_agents;
create trigger source_agents_updated_at before update on public.source_agents
  for each row execute function public.set_updated_at();
drop trigger if exists conversations_updated_at on public.conversations;
create trigger conversations_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();
drop trigger if exists conversation_agents_updated_at on public.conversation_agents;
create trigger conversation_agents_updated_at before update on public.conversation_agents
  for each row execute function public.set_updated_at();

-- Row-level security ----------------------------------------------------------
-- Owner-scoped access for authenticated clients; private keys are service-role
-- only (no authenticated policy row can reach them).

alter table public.profiles enable row level security;
alter table public.documents enable row level security;
alter table public.source_agents enable row level security;
alter table public.agent_artifacts enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_agents enable row level security;
alter table public.conversation_events enable row level security;

drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles
  for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists documents_owner on public.documents;
create policy documents_owner on public.documents
  for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists source_agents_owner on public.source_agents;
create policy source_agents_owner on public.source_agents
  for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists agent_artifacts_owner on public.agent_artifacts;
create policy agent_artifacts_owner on public.agent_artifacts
  for select to authenticated
  using (
    kind <> 'private_key'
    and exists (
      select 1 from public.source_agents sa
      where sa.agent_id = agent_artifacts.agent_id and sa.owner = auth.uid()
    )
  );

drop policy if exists conversations_owner on public.conversations;
create policy conversations_owner on public.conversations
  for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists conversation_agents_owner on public.conversation_agents;
create policy conversation_agents_owner on public.conversation_agents
  for all to authenticated
  using (exists (
    select 1 from public.conversations c
    where c.token = conversation_agents.conversation_token and c.owner = auth.uid()
  ))
  with check (exists (
    select 1 from public.conversations c
    where c.token = conversation_agents.conversation_token and c.owner = auth.uid()
  ));

drop policy if exists conversation_events_owner_select on public.conversation_events;
create policy conversation_events_owner_select on public.conversation_events
  for select to authenticated
  using (exists (
    select 1 from public.conversations c
    where c.token = conversation_events.conversation_token and c.owner = auth.uid()
  ));

drop policy if exists conversation_events_owner_insert on public.conversation_events;
create policy conversation_events_owner_insert on public.conversation_events
  for insert to authenticated
  with check (exists (
    select 1 from public.conversations c
    where c.token = conversation_events.conversation_token and c.owner = auth.uid()
  ));

-- No update/delete policies on conversation_events for authenticated: the
-- stream is append-only (and the trigger above enforces it for every role).

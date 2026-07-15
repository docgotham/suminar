-- Suminar pilot limits: hardcoded, visible, invite-beta resource quotas.
-- These are abuse guards, not rationing — a working scholar will not reach
-- them. Volume enforcement lives in BEFORE INSERT triggers so every write
-- path is covered uniformly: the service-role hosted layer (which bypasses
-- RLS but never triggers) and any future authenticated path share one gate.
-- Rejections raise P0001 with a plain-language message naming the limit and
-- the number; the hosted layer relays that message verbatim as a
-- client-actionable rejection.

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
    'waitlistMaxEntries', 10000
  );
$$;

revoke all on function public.pilot_limits() from public, anon;
grant execute on function public.pilot_limits() to authenticated;
grant execute on function public.pilot_limits() to service_role;

-- Invocation metering -----------------------------------------------------
-- One row per source-agent invocation, inserted by the hosted layer before
-- the model call: reserve, then spend. The row doubles as the metering data
-- that calibrates future caps. Owners can read their own meter; only the
-- service role writes it.

create table if not exists public.invocation_usage (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  agent_id text not null,
  invocation_id text,
  created_at timestamptz not null default now()
);
create index if not exists invocation_usage_owner_created_idx
  on public.invocation_usage (owner, created_at desc);

alter table public.invocation_usage enable row level security;

drop policy if exists invocation_usage_owner_read on public.invocation_usage;
create policy invocation_usage_owner_read on public.invocation_usage
  for select to authenticated
  using (owner = auth.uid());

revoke all on table public.invocation_usage from public, anon;
grant select on table public.invocation_usage to authenticated;
grant all on table public.invocation_usage to service_role;

create or replace function public.enforce_invocation_pilot_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day_limit integer := (public.pilot_limits() ->> 'invocationsPerAccountPerDay')::integer;
  v_month_limit integer := (public.pilot_limits() ->> 'invocationsPerAccountPerMonth')::integer;
begin
  if (select count(*) from public.invocation_usage
      where owner = new.owner
        and created_at > now() - interval '24 hours') >= v_day_limit then
    raise exception 'Suminar pilot limit: the invite beta allows % source-agent invocations per account per day', v_day_limit;
  end if;
  if (select count(*) from public.invocation_usage
      where owner = new.owner
        and created_at > now() - interval '30 days') >= v_month_limit then
    raise exception 'Suminar pilot limit: the invite beta allows % source-agent invocations per account per 30 days', v_month_limit;
  end if;
  return new;
end;
$$;

drop trigger if exists invocation_usage_pilot_limit on public.invocation_usage;
create trigger invocation_usage_pilot_limit
  before insert on public.invocation_usage
  for each row execute function public.enforce_invocation_pilot_limit();

-- Document and storage caps -------------------------------------------------
-- Insert-only: status transitions during processing must not re-trip the
-- count check once an account sits at its cap.

create or replace function public.enforce_document_pilot_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc_limit integer := (public.pilot_limits() ->> 'documentsPerAccount')::integer;
  v_storage_limit bigint := (public.pilot_limits() ->> 'storageBytesPerAccount')::bigint;
  v_upload_limit bigint := (public.pilot_limits() ->> 'uploadMaxBytes')::bigint;
begin
  if new.byte_size > v_upload_limit then
    raise exception 'Suminar pilot limit: a single upload may hold up to % bytes', v_upload_limit;
  end if;
  if (select count(*) from public.documents where owner = new.owner) >= v_doc_limit then
    raise exception 'Suminar pilot limit: the invite beta allows % documents per account', v_doc_limit;
  end if;
  if coalesce((select sum(byte_size) from public.documents where owner = new.owner), 0) + new.byte_size > v_storage_limit then
    raise exception 'Suminar pilot limit: the invite beta allows % bytes of uploaded sources per account', v_storage_limit;
  end if;
  return new;
end;
$$;

drop trigger if exists documents_pilot_limit on public.documents;
create trigger documents_pilot_limit
  before insert on public.documents
  for each row execute function public.enforce_document_pilot_limit();

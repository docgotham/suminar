-- Fixed-window rate limiting for the hosted MCP, OAuth, upload, export,
-- admin, and waitlist doors. One self-resetting row per key: the upsert
-- either increments the current window's counter or starts a new window, so
-- no cleanup job is required and the table stays bounded by distinct-key
-- cardinality. The function is service-role only — limits are enforced by
-- the hosted layer in front of the data layer, never consulted by browsers —
-- and the hosted layer fails open if this function is unreachable, because
-- rate limiting must never be the outage.

create table if not exists public.rate_limit_counters (
  key text primary key,
  window_start timestamptz not null,
  hits integer not null check (hits >= 0)
);

alter table public.rate_limit_counters enable row level security;
revoke all on table public.rate_limit_counters from public, anon, authenticated;
grant all on table public.rate_limit_counters to service_role;

create or replace function public.check_rate_limit(p_key text, p_max_hits integer, p_window_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_hits integer;
  v_retry_after integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Suminar check_rate_limit is service-role only';
  end if;

  if p_key is null or p_max_hits is null or p_max_hits < 1 or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'check_rate_limit requires a key, a positive max, and a positive window';
  end if;

  v_window_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limit_counters as c (key, window_start, hits)
  values (p_key, v_window_start, 1)
  on conflict (key) do update
    set hits = case when c.window_start = excluded.window_start then c.hits + 1 else 1 end,
        window_start = excluded.window_start
  returning c.hits into v_hits;

  v_retry_after := greatest(
    1,
    ceil(extract(epoch from (v_window_start + make_interval(secs => p_window_seconds) - now())))::integer
  );

  return jsonb_build_object(
    'allowed', v_hits <= p_max_hits,
    'remaining', greatest(p_max_hits - v_hits, 0),
    'retryAfterSeconds', case when v_hits <= p_max_hits then 0 else v_retry_after end
  );
end;
$$;

revoke all on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;

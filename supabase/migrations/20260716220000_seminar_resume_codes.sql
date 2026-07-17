-- Seminar portability, increment A: resume codes. The companion mints a
-- short-lived, one-use, hash-at-rest code for a seminar the owner wants to
-- continue from another host (or stitch back together after a token-dropped
-- fork). Redeeming it — self-resume only in increment A, enforced by owner
-- match — hands the SAME conversation continuation state to the new host.
-- Portability is an explicit user action carrying a visible code, never a
-- hidden linkage.

create table if not exists public.seminar_resume_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),
  conversation_token text not null references public.conversations(token) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '1 hour',
  used_at timestamptz
);
create index if not exists seminar_resume_codes_owner_idx on public.seminar_resume_codes (owner, created_at desc);

alter table public.seminar_resume_codes enable row level security;
grant all on table public.seminar_resume_codes to service_role;

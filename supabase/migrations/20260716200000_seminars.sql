-- Seminars: the owner-facing view of conversations, for the companion
-- surface. Conversations are keyed by their secret continuation tokens; a
-- companion URL must never carry a credential, so each conversation gains a
-- public identifier — and an owner-editable title, derived-by-default and
-- renamed at will (explicit wins, the standing rule).

alter table public.conversations
  add column if not exists id uuid not null default gen_random_uuid();
create unique index if not exists conversations_id_idx on public.conversations (id);

alter table public.conversations
  add column if not exists title text
  check (title is null or (length(title) >= 1 and length(title) <= 200));

-- One owner-scoped read for the companion's seminar list: newest first, with
-- the raw material for a derived title (first user turn), the participant
-- roster (agents actually seated, from conversation_agents), and the count of
-- canonical agent turns (zero-agent-turn conversations are sync-only stubs or
-- token-loss husks; the client hides them behind "show all").
create or replace function public.list_seminars(p_owner uuid, p_limit integer default 50)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(seminar order by updated_at desc), '[]'::jsonb)
  from (
    select c.updated_at,
      jsonb_build_object(
        'seminarId', c.id,
        'title', c.title,
        'createdAt', c.created_at,
        'updatedAt', c.updated_at,
        'agentTurns', (
          select count(*) from public.conversation_events e
          where e.conversation_token = c.token
            and e.event->>'speakerType' = 'source_agent'
        ),
        'firstUserLine', (
          select e.event->>'authoredMessage' from public.conversation_events e
          where e.conversation_token = c.token
            and e.event->>'speakerType' = 'user'
          order by e.sequence
          limit 1
        ),
        'participants', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'handle', ca.agent_ref->>'handle',
            'displayName', ca.agent_ref->>'displayName'
          ) order by ca.created_at), '[]'::jsonb)
          from public.conversation_agents ca
          where ca.conversation_token = c.token
        )
      ) as seminar
    from public.conversations c
    where c.owner = p_owner
    order by c.updated_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) ranked
$$;

revoke all on function public.list_seminars(uuid, integer) from public;
grant execute on function public.list_seminars(uuid, integer) to service_role;

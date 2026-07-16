-- Liveness is event time, not row time: conversations.updated_at bumps on any
-- row change (a title rename made a legacy seminar read "live" and would have
-- reshuffled the list). list_seminars now carries lastEventAt — when the
-- record itself last grew — and orders by it, so renames neither light the
-- live badge nor rewrite history.

create or replace function public.list_seminars(p_owner uuid, p_limit integer default 50)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(seminar order by last_event_at desc), '[]'::jsonb)
  from (
    select le.last_event_at,
      jsonb_build_object(
        'seminarId', c.id,
        'title', c.title,
        'createdAt', c.created_at,
        'updatedAt', c.updated_at,
        'lastEventAt', le.last_event_at,
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
    cross join lateral (
      select coalesce(max(e.created_at), c.created_at) as last_event_at
      from public.conversation_events e
      where e.conversation_token = c.token
    ) le
    where c.owner = p_owner
    order by le.last_event_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) ranked
$$;

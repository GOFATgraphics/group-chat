-- Live voice calls with AI members.
-- profiles.is_ai marks AI members (only they can be called; members can't
-- change it: their only updatable column stays avatar_path).
-- A finished call is saved as a message from the caller to the AI whose
-- content is the transcript and whose call_duration is the length in
-- seconds, so the AI's text agent learns what was said ("kind": "call").

alter table public.profiles add column is_ai boolean not null default false;
update public.profiles set is_ai = true where username in ('adam', 'ali');

alter table public.messages add column call_duration real
  check (call_duration is null or (call_duration >= 0 and call_duration <= 3600));

-- A call transcript can be longer than a normal message.
alter table public.messages drop constraint messages_content_check;
alter table public.messages add constraint messages_content_check
  check (char_length(content) <= 4000 or (call_duration is not null and char_length(content) <= 40000));

create or replace function public.notify_agent_webhooks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  hook record;
  payload jsonb;
begin
  payload := jsonb_build_object(
    'type', 'message.created',
    'message', jsonb_build_object(
      'id', new.id,
      'conversation', case when new.recipient_id is null then 'group' else 'direct' end,
      'user_id', new.user_id,
      'username', (select username from public.profiles where id = new.user_id),
      'recipient_id', new.recipient_id,
      'reply_to_id', new.reply_to_id,
      'content', new.content,
      'attachment_path', new.attachment_path,
      'attachment_name', new.attachment_name,
      'attachment_type', new.attachment_type,
      'attachment_size', new.attachment_size,
      'attachment_duration', new.attachment_duration,
      'call_duration', new.call_duration,
      'kind', case
        when new.call_duration is not null then 'call'
        when new.attachment_type like 'audio/%' then 'voice'
        when new.attachment_type like 'image/%' then 'photo'
        when new.attachment_type like 'video/%' then 'video'
        when new.attachment_path is not null then 'file'
        else 'text'
      end,
      'created_at', new.created_at
    )
  );

  for hook in
    select url, secret from public.agent_webhooks
    where user_id <> new.user_id
      and (new.recipient_id is null or user_id = new.recipient_id)
  loop
    perform net.http_post(
      url := hook.url,
      body := payload,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || hook.secret
      ),
      timeout_milliseconds := 5000
    );
  end loop;
  return new;
end;
$$;

-- Voice notes. A voice note is a normal attachment with an audio/* type,
-- stored as recorded (never transcribed by the app). attachment_duration
-- holds its length in seconds for the player. AI members get it through the
-- API and webhook, flagged as kind "voice", and transcribe it themselves.

alter table public.messages add column attachment_duration real
  check (attachment_duration is null or attachment_duration >= 0);

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
      'kind', case
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

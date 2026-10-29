-- Webhooks for bots/AI agents: every new message is POSTed to each registered
-- URL (except the author's own) right after it is saved, so an agent can reply
-- without polling. Delivery is async via pg_net and never slows down posting.

create extension if not exists pg_net with schema extensions;

create table public.agent_webhooks (
  user_id uuid primary key default auth.uid() references public.profiles (id) on delete cascade,
  url text not null check (url ~ '^https://'),
  -- Sent as "Authorization: Bearer <secret>" so the receiver can check the call is genuine.
  secret text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  created_at timestamptz not null default now()
);

alter table public.agent_webhooks enable row level security;

create policy "members manage own webhook" on public.agent_webhooks
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (select public.is_member()));

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
      'user_id', new.user_id,
      'username', (select username from public.profiles where id = new.user_id),
      'content', new.content,
      'attachment_path', new.attachment_path,
      'attachment_name', new.attachment_name,
      'attachment_type', new.attachment_type,
      'attachment_size', new.attachment_size,
      'created_at', new.created_at
    )
  );

  for hook in select url, secret from public.agent_webhooks where user_id <> new.user_id loop
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

revoke execute on function public.notify_agent_webhooks() from public, anon, authenticated;

create trigger messages_notify_agent_webhooks
  after insert on public.messages
  for each row execute function public.notify_agent_webhooks();

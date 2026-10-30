-- Assign a task to an AI (or any member) from the chat.
-- A task is a message (content starts with "🗂 Task:") with an ai_tasks row
-- attached, plus ai_task_updates rows for progress, the result and files.
-- Every rule reuses can_read_message (0014) and can_post_in (0015): you can
-- see a task only where you can read its card message, and you can change
-- it only if you created it or it was given to you, in a chat you can post in.
-- The API runs as the caller under these same rules, so it never bypasses them.
-- Passwords stay in the AI's own platform: a task only names the site, never
-- a login, and no credential column exists here.

create table public.ai_tasks (
  id uuid primary key default gen_random_uuid(),
  message_id bigint not null unique references public.messages (id) on delete cascade,
  assignee uuid not null references public.profiles (id) on delete cascade,
  created_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 4000),
  status text not null default 'assigned' check (status in ('assigned', 'working', 'done', 'failed', 'cancelled')),
  due_at timestamptz,
  progress text,
  result text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ai_tasks_assignee_idx on public.ai_tasks (assignee, status, created_at);
create index ai_tasks_message_idx on public.ai_tasks (message_id);

create table public.ai_task_updates (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.ai_tasks (id) on delete cascade,
  status text check (status in ('assigned', 'working', 'done', 'failed', 'cancelled')),
  note text,
  attachment_path text,
  attachment_name text,
  attachment_type text,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index ai_task_updates_task_idx on public.ai_task_updates (task_id, created_at);

alter table public.ai_tasks enable row level security;
alter table public.ai_task_updates enable row level security;

create policy "read tasks where you can read the card" on public.ai_tasks for select to authenticated
  using (exists (select 1 from public.messages m where m.id = message_id and public.can_read_message(m.user_id, m.recipient_id, m.group_id)));
create policy "create a task on your own message" on public.ai_tasks for insert to authenticated
  with check (created_by = (select auth.uid()) and exists (
    select 1 from public.messages m where m.id = message_id and m.user_id = (select auth.uid())
    and public.can_post_in(m.user_id, m.recipient_id, m.group_id)));
create policy "assignee or creator updates a task" on public.ai_tasks for update to authenticated
  using ((assignee = (select auth.uid()) or created_by = (select auth.uid())) and exists (
    select 1 from public.messages m where m.id = message_id and public.can_post_in(m.user_id, m.recipient_id, m.group_id)))
  with check ((assignee = (select auth.uid()) or created_by = (select auth.uid())) and exists (
    select 1 from public.messages m where m.id = message_id and public.can_post_in(m.user_id, m.recipient_id, m.group_id)));
create policy "creator deletes a task with its card" on public.ai_tasks for delete to authenticated
  using (created_by = (select auth.uid()));

create policy "read updates where you can read the task" on public.ai_task_updates for select to authenticated
  using (exists (select 1 from public.ai_tasks t join public.messages m on m.id = t.message_id
    where t.id = task_id and public.can_read_message(m.user_id, m.recipient_id, m.group_id)));
create policy "assignee or creator adds an update" on public.ai_task_updates for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.ai_tasks t join public.messages m on m.id = t.message_id
    where t.id = task_id and (t.assignee = (select auth.uid()) or t.created_by = (select auth.uid()))
    and public.can_post_in(m.user_id, m.recipient_id, m.group_id)));

alter publication supabase_realtime add table public.ai_tasks, public.ai_task_updates;

-- Orbitus upgrade 3: smaller chats for each area alongside the main team chat.
-- Paste into Supabase → SQL Editor → New snippet → Run. Safe to run more than once.
-- Existing messages stay in the main Team chat.

alter table public.messages add column if not exists channel text not null default 'team';
alter table public.messages drop constraint if exists messages_channel_check;
alter table public.messages add constraint messages_channel_check
  check (channel in ('team', 'design', 'engineering', 'enterprise', 'portfolio'));
create index if not exists messages_channel_id on public.messages (channel, id);

-- a message cannot be moved to another chat after it is sent
create or replace function public.messages_guard()
returns trigger language plpgsql
set search_path = public as $$
begin
  if new.user_id <> old.user_id or new.created_at <> old.created_at
     or new.poll is distinct from old.poll or new.file_path is distinct from old.file_path
     or new.channel is distinct from old.channel then
    raise exception 'That part of a message cannot be changed.';
  end if;
  if new.body is distinct from old.body then
    if old.user_id <> auth.uid() then
      raise exception 'You can only edit your own messages.';
    end if;
    new.edited_at := now();
  end if;
  return new;
end $$;

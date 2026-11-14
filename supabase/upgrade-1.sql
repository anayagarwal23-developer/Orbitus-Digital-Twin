-- Orbitus upgrade 1: replies, reactions, files in chat, mission due dates
-- and categories. Paste into Supabase → SQL Editor → New snippet → Run.
-- Safe to run more than once. Already included in setup.sql for new projects.

-- Chat: replies and attachments ---------------------------------------------
alter table public.messages add column if not exists reply_to bigint references public.messages on delete set null;
alter table public.messages add column if not exists file_path text;
alter table public.messages add column if not exists file_name text check (file_name is null or char_length(file_name) <= 200);
alter table public.messages add column if not exists file_type text check (file_type is null or char_length(file_type) <= 120);
alter table public.messages add column if not exists file_size integer check (file_size is null or file_size between 0 and 10485760);
alter table public.messages alter column body set default '';
alter table public.messages drop constraint if exists messages_body_check;
alter table public.messages drop constraint if exists messages_content_check;
alter table public.messages add constraint messages_content_check
  check (char_length(body) <= 2000 and (char_length(btrim(body)) > 0 or file_path is not null));

-- Chat: reactions ------------------------------------------------------------
create table if not exists public.reactions (
  message_id bigint not null references public.messages on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
alter table public.reactions enable row level security;
drop policy if exists "team reads reactions"  on public.reactions;
drop policy if exists "team adds reactions"   on public.reactions;
drop policy if exists "remove own reactions"  on public.reactions;
create policy "team reads reactions" on public.reactions for select to authenticated using (public.is_team());
create policy "team adds reactions"  on public.reactions for insert to authenticated with check (public.is_team() and user_id = auth.uid());
create policy "remove own reactions" on public.reactions for delete to authenticated using (public.is_team() and user_id = auth.uid());
revoke all on public.reactions from anon;
grant select, insert, delete on public.reactions to authenticated;

-- Missions: due dates and categories --------------------------------------
alter table public.missions add column if not exists due date;
alter table public.missions add column if not exists category text;
alter table public.missions drop constraint if exists missions_category_check;
alter table public.missions add constraint missions_category_check
  check (category is null or category in ('Design', 'Manufacturing', 'Enterprise', 'Portfolio'));

-- Files: a private storage bucket only the team can use --------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files', 'chat-files', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;

drop policy if exists "team reads chat files"   on storage.objects;
drop policy if exists "team uploads chat files" on storage.objects;
drop policy if exists "delete own chat files"   on storage.objects;
create policy "team reads chat files" on storage.objects for select to authenticated
  using (bucket_id = 'chat-files' and public.is_team());
create policy "team uploads chat files" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-files' and public.is_team() and (storage.foldername(name))[1] = auth.uid()::text);
create policy "delete own chat files" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-files' and public.is_team() and (storage.foldername(name))[1] = auth.uid()::text);

-- Live updates for reactions -------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reactions'
  ) then
    alter publication supabase_realtime add table public.reactions;
  end if;
end $$;

-- Orbitus Digital Twin: database setup.
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- It is safe to run more than once.

-- 1. Who is on the team -------------------------------------------------
-- Only people whose login email is in this table can read or write anything.
create table if not exists public.team_members (
  email text primary key
);
alter table public.team_members enable row level security;
-- No policies on purpose: the app can never read or change this list.
-- Edit it from the Supabase dashboard (Table Editor → team_members).

create or replace function public.is_team()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_members
    where lower(btrim(email, E' \n\r\t')) = lower(btrim(auth.jwt() ->> 'email'))
  );
$$;

-- 2. Tables ---------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  day date not null,
  at time,
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now()
);

create table if not exists public.missions (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  owner uuid references public.profiles on delete set null,
  done boolean not null default false,
  done_by uuid references public.profiles on delete set null,
  done_at timestamptz,
  created_at timestamptz not null default now()
);

-- 3. Privacy rules ------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.messages enable row level security;
alter table public.events   enable row level security;
alter table public.missions enable row level security;

drop policy if exists "team reads profiles"  on public.profiles;
drop policy if exists "add own profile"      on public.profiles;
drop policy if exists "edit own profile"     on public.profiles;
create policy "team reads profiles" on public.profiles for select to authenticated using (public.is_team());
create policy "add own profile"     on public.profiles for insert to authenticated with check (public.is_team() and id = auth.uid());
create policy "edit own profile"    on public.profiles for update to authenticated using (public.is_team() and id = auth.uid()) with check (id = auth.uid());

drop policy if exists "team reads messages"  on public.messages;
drop policy if exists "team sends messages"  on public.messages;
drop policy if exists "delete own messages"  on public.messages;
create policy "team reads messages" on public.messages for select to authenticated using (public.is_team());
create policy "team sends messages" on public.messages for insert to authenticated with check (public.is_team() and user_id = auth.uid());
create policy "delete own messages" on public.messages for delete to authenticated using (public.is_team() and user_id = auth.uid());

drop policy if exists "team reads events"    on public.events;
drop policy if exists "team adds events"     on public.events;
drop policy if exists "team edits events"    on public.events;
drop policy if exists "team deletes events"  on public.events;
create policy "team reads events"   on public.events for select to authenticated using (public.is_team());
create policy "team adds events"    on public.events for insert to authenticated with check (public.is_team() and user_id = auth.uid());
create policy "team edits events"   on public.events for update to authenticated using (public.is_team()) with check (public.is_team());
create policy "team deletes events" on public.events for delete to authenticated using (public.is_team());

drop policy if exists "team reads missions"   on public.missions;
drop policy if exists "team adds missions"    on public.missions;
drop policy if exists "team edits missions"   on public.missions;
drop policy if exists "team deletes missions" on public.missions;
create policy "team reads missions"   on public.missions for select to authenticated using (public.is_team());
create policy "team adds missions"    on public.missions for insert to authenticated with check (public.is_team() and user_id = auth.uid());
create policy "team edits missions"   on public.missions for update to authenticated using (public.is_team()) with check (public.is_team());
create policy "team deletes missions" on public.missions for delete to authenticated using (public.is_team());

-- People who are not signed in get nothing at all.
revoke all on public.team_members, public.profiles, public.messages, public.events, public.missions from anon;

-- Signed-in people may use the tables; the rules above decide which rows.
grant select, insert, update on public.profiles to authenticated;
grant select, insert, delete on public.messages to authenticated;
grant select, insert, update, delete on public.events, public.missions to authenticated;
grant execute on function public.is_team() to authenticated;

-- 4. Live updates -------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['profiles','messages','events','missions'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 5. The team ---------------------------------------------------------------
-- Replace these with the five real login emails, then run this file.
-- insert into public.team_members (email) values
--   ('first@example.com'),
--   ('second@example.com')
-- on conflict do nothing;

-- 6. Replies, reactions, files, mission due dates and categories ---------

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

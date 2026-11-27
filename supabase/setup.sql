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

-- 7. Polls, pins, editing, read receipts, repeats, photos, car log, budget,
--    files, home settings and notifications --------------------------------

-- Chat: editing, pins, polls -------------------------------------------------
alter table public.messages add column if not exists edited_at timestamptz;
alter table public.messages add column if not exists pinned boolean not null default false;
alter table public.messages add column if not exists pinned_by uuid references public.profiles on delete set null;
alter table public.messages add column if not exists poll jsonb;
alter table public.messages drop constraint if exists messages_content_check;
alter table public.messages add constraint messages_content_check
  check (char_length(body) <= 2000 and (char_length(btrim(body)) > 0 or file_path is not null or poll is not null));

drop policy if exists "team updates messages" on public.messages;
create policy "team updates messages" on public.messages for update to authenticated
  using (public.is_team()) with check (public.is_team());
grant update on public.messages to authenticated;

-- Anyone on the team can pin; only the author can change the words.
create or replace function public.messages_guard()
returns trigger language plpgsql
set search_path = public as $$
begin
  if new.user_id <> old.user_id or new.created_at <> old.created_at
     or new.poll is distinct from old.poll or new.file_path is distinct from old.file_path then
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
drop trigger if exists messages_guard on public.messages;
create trigger messages_guard before update on public.messages
  for each row execute function public.messages_guard();

create table if not exists public.poll_votes (
  message_id bigint not null references public.messages on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  choice smallint not null check (choice between 0 and 9),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- Chat: who has read up to where ---------------------------------------------
create table if not exists public.reads (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  last_read bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- Calendar: repeating events ------------------------------------------------
alter table public.events add column if not exists repeat text;
alter table public.events add column if not exists repeat_until date;
alter table public.events drop constraint if exists events_repeat_check;
alter table public.events add constraint events_repeat_check
  check (repeat is null or repeat in ('weekly', 'fortnightly', 'monthly'));

-- Profile photos ---------------------------------------------------------------
alter table public.profiles add column if not exists avatar_path text;

-- Car log -----------------------------------------------------------------------
create table if not exists public.runs (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  day date not null,
  time_s numeric(7,3) not null check (time_s > 0 and time_s < 100),
  car text check (car is null or char_length(car) <= 60),
  parts text check (parts is null or char_length(parts) <= 500),
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now()
);

-- Budget ------------------------------------------------------------------------
create table if not exists public.ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  day date not null,
  kind text not null check (kind in ('in', 'out')),
  amount numeric(12,2) not null check (amount > 0),
  label text not null check (char_length(label) between 1 and 120),
  category text check (category is null or char_length(category) <= 40),
  file_path text,
  file_name text check (file_name is null or char_length(file_name) <= 200),
  created_at timestamptz not null default now()
);

-- Files -------------------------------------------------------------------------
create table if not exists public.files (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  folder text not null default 'Other' check (folder in ('Portfolio', 'Design', 'Engineering', 'Enterprise', 'Other')),
  file_path text not null,
  file_type text check (file_type is null or char_length(file_type) <= 120),
  file_size integer check (file_size is null or file_size between 0 and 26214400),
  created_at timestamptz not null default now()
);

-- Shared settings (next competition date) ----------------------------------
create table if not exists public.settings (
  key text primary key check (char_length(key) <= 40),
  value jsonb not null,
  updated_by uuid default auth.uid() references auth.users on delete set null,
  updated_at timestamptz not null default now()
);

-- Phone notifications -------------------------------------------------------
create table if not exists public.push_keys (
  id smallint primary key check (id = 1),
  public_key text not null,
  private_key text not null
);
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  p256dh text not null,
  auth text not null,
  mode text not null default 'all' check (mode in ('all', 'mentions')),
  created_at timestamptz not null default now()
);

-- Privacy rules: team only, everywhere --------------------------------------
do $$
declare t text;
begin
  foreach t in array array['poll_votes','reads','runs','ledger','files','settings','push_keys','push_subscriptions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('drop policy if exists "team reads" on public.%I', t);
    execute format('create policy "team reads" on public.%I for select to authenticated using (public.is_team())', t);
  end loop;

  -- rows that belong to the person who made them
  foreach t in array array['poll_votes','reads','push_subscriptions'] loop
    execute format('drop policy if exists "add own" on public.%I', t);
    execute format('drop policy if exists "change own" on public.%I', t);
    execute format('create policy "add own" on public.%I for insert to authenticated with check (public.is_team() and user_id = auth.uid())', t);
    execute format('create policy "change own" on public.%I for update to authenticated using (public.is_team() and user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
  drop policy if exists "remove own" on public.poll_votes;
  create policy "remove own" on public.poll_votes for delete to authenticated using (public.is_team() and user_id = auth.uid());
  drop policy if exists "team removes" on public.push_subscriptions;
  create policy "team removes" on public.push_subscriptions for delete to authenticated using (public.is_team());

  -- shared records anyone on the team can add to or tidy up
  foreach t in array array['runs','ledger','files'] loop
    execute format('drop policy if exists "team adds" on public.%I', t);
    execute format('drop policy if exists "team changes" on public.%I', t);
    execute format('drop policy if exists "team removes" on public.%I', t);
    execute format('create policy "team adds" on public.%I for insert to authenticated with check (public.is_team() and user_id = auth.uid())', t);
    execute format('create policy "team changes" on public.%I for update to authenticated using (public.is_team()) with check (public.is_team())', t);
    execute format('create policy "team removes" on public.%I for delete to authenticated using (public.is_team())', t);
  end loop;

  drop policy if exists "team adds" on public.settings;
  drop policy if exists "team changes" on public.settings;
  create policy "team adds" on public.settings for insert to authenticated with check (public.is_team());
  create policy "team changes" on public.settings for update to authenticated using (public.is_team()) with check (public.is_team());

  drop policy if exists "team adds" on public.push_keys;
  create policy "team adds" on public.push_keys for insert to authenticated with check (public.is_team());
end $$;

grant select, insert, update, delete on public.poll_votes, public.runs, public.ledger, public.files to authenticated;
grant select, insert, update on public.reads, public.settings to authenticated;
grant select, insert on public.push_keys to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- Storage: bigger files for the Files tab, and the team can tidy shared files
update storage.buckets set file_size_limit = 26214400 where id = 'chat-files';
drop policy if exists "delete own chat files" on storage.objects;
drop policy if exists "team deletes chat files" on storage.objects;
create policy "team deletes chat files" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-files' and public.is_team());

-- Live updates ------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['poll_votes','reads','runs','ledger','files','settings'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Chat channels (upgrade 3)

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

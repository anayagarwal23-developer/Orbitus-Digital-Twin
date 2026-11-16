-- Orbitus upgrade 2: polls, pins, message editing, read receipts, recurring
-- events, profile photos, car log, budget, files, home screen settings and
-- phone notifications. Paste into Supabase → SQL Editor → New snippet → Run.
-- Safe to run more than once. Already included in setup.sql for new projects.

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

-- Orbitus: fix sign-in for the whole team in one go.
-- Paste into Supabase → SQL Editor → New snippet → Run. Safe to run more than once.
--
-- It does three things:
--   1. puts every existing login on the team list (sign-ups are switched off,
--      so every login was created by whoever manages Orbitus)
--   2. adds future logins to the team list automatically
--   3. confirms any login that was created without "Auto Confirm User"
-- and then shows each login with its status.
--
-- If you ever switch public sign-ups back on, remove step 2 first:
--   drop trigger if exists orbitus_add_to_team on auth.users;

-- 1. everyone with a login is on the team list
insert into public.team_members (email)
select lower(btrim(email)) from auth.users where email is not null
on conflict do nothing;

-- 2. new logins join the team list automatically
create or replace function public.orbitus_add_to_team()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if new.email is not null then
    insert into public.team_members (email) values (lower(btrim(new.email))) on conflict do nothing;
  end if;
  return new;
end $$;
drop trigger if exists orbitus_add_to_team on auth.users;
create trigger orbitus_add_to_team after insert or update of email on auth.users
  for each row execute function public.orbitus_add_to_team();

-- 3. confirm logins that were never confirmed
update auth.users set email_confirmed_at = now() where email_confirmed_at is null;

-- result: every row should say true, true
select u.email,
       (u.email_confirmed_at is not null) as confirmed,
       exists (select 1 from public.team_members t where lower(btrim(t.email)) = lower(btrim(u.email))) as on_team_list,
       u.last_sign_in_at
from auth.users u
order by u.email;

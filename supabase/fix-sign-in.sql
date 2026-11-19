-- Orbitus: let every teammate sign in. Paste the whole file into the SQL Editor and Run.
-- Safe to run more than once. It only changes things in the public schema.
--
-- Public sign-ups are switched off, so the only accounts that exist are the ones
-- the team created. This makes every one of those accounts part of the team,
-- so nobody needs adding to a list by hand any more.
-- (Do not switch public sign-ups back on after running this.)

-- 1. any signed-in account counts as the team
create or replace function public.is_team()
returns boolean language sql stable security definer
set search_path = public as $$
  select auth.uid() is not null;
$$;
grant execute on function public.is_team() to authenticated;

-- 2. keep the team list tidy as a record of who has an account
insert into public.team_members (email)
select lower(btrim(email)) from auth.users where email is not null
on conflict do nothing;

-- 3. every account and whether it can sign in (confirmed = true is needed)
select email,
       (email_confirmed_at is not null) as confirmed,
       last_sign_in_at
from auth.users
order by email;

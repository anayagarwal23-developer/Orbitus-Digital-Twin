-- Orbitus: open sign-in, with admins who can remove people.
-- Paste the whole file into the SQL Editor and Run. Safe to run more than once.
-- It only changes things in the public schema.
--
-- After this, anyone who signs up with their email can use Orbitus, and admins
-- can remove anyone who shouldn't be there (Settings → Team in the app).
-- Removing someone takes away their access straight away; their messages stay.
-- The admin is Anay (anayagarwal23@gmail.com). Anay can make others admins in the app.

-- who has been removed, and who can remove people
create table if not exists public.removed_members (
  user_id uuid primary key references auth.users on delete cascade,
  name text, email text,
  removed_by uuid references auth.users on delete set null,
  removed_at timestamptz not null default now()
);
create table if not exists public.admins (
  user_id uuid primary key references auth.users on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.removed_members enable row level security;
alter table public.admins enable row level security;
revoke all on public.removed_members, public.admins from anon;

-- everyone signed in is on the team, unless an admin removed them
create or replace function public.is_team()
returns boolean language sql stable security definer
set search_path = public as $$
  select auth.uid() is not null
     and not exists (select 1 from public.removed_members r where r.user_id = auth.uid());
$$;
create or replace function public.is_admin()
returns boolean language sql stable security definer
set search_path = public as $$
  select public.is_team() and exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

drop policy if exists "team reads admins" on public.admins;
create policy "team reads admins" on public.admins for select to authenticated using (public.is_team());
drop policy if exists "admins read removed" on public.removed_members;
create policy "admins read removed" on public.removed_members for select to authenticated using (public.is_admin());
grant select on public.admins, public.removed_members to authenticated;

-- every account with its email, for admins only
create or replace function public.member_emails()
returns table (user_id uuid, email text, created_at timestamptz)
language sql stable security definer
set search_path = public as $$
  select u.id, u.email::text, u.created_at from auth.users u where public.is_admin() order by u.created_at;
$$;

create or replace function public.remove_member(target uuid)
returns void language plpgsql security definer
set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only admins can remove people.'; end if;
  if target = auth.uid() then raise exception 'You cannot remove yourself.'; end if;
  if exists (select 1 from public.admins where user_id = target) then raise exception 'Take away their admin role first.'; end if;
  insert into public.removed_members (user_id, name, email, removed_by)
  select target, (select p.name from public.profiles p where p.id = target), (select u.email from auth.users u where u.id = target), auth.uid()
  on conflict (user_id) do nothing;
end $$;

create or replace function public.restore_member(target uuid)
returns void language plpgsql security definer
set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only admins can let people back in.'; end if;
  delete from public.removed_members where user_id = target;
end $$;

create or replace function public.set_admin(target uuid, make boolean)
returns void language plpgsql security definer
set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only admins can change admins.'; end if;
  if not make and target = auth.uid() then raise exception 'You cannot remove your own admin role.'; end if;
  if make then
    if exists (select 1 from public.removed_members where user_id = target) then raise exception 'Let them back in first.'; end if;
    insert into public.admins (user_id) values (target) on conflict do nothing;
  else
    delete from public.admins where user_id = target;
  end if;
end $$;

revoke all on function public.member_emails(), public.remove_member(uuid), public.restore_member(uuid), public.set_admin(uuid, boolean) from public, anon;
grant execute on function public.is_team(), public.is_admin(), public.member_emails(), public.remove_member(uuid), public.restore_member(uuid), public.set_admin(uuid, boolean) to authenticated;

-- the admin: Anay's account (if that email has no account, the first account created instead)
insert into public.admins (user_id) select id from auth.users where lower(email) = 'anayagarwal23@gmail.com' on conflict do nothing;
insert into public.admins (user_id)
select id from auth.users where not exists (select 1 from public.admins) order by created_at limit 1
on conflict do nothing;

-- result: every account, whether it can sign in, and its role
select u.email,
       (u.email_confirmed_at is not null) as confirmed,
       exists (select 1 from public.admins a where a.user_id = u.id) as admin,
       exists (select 1 from public.removed_members r where r.user_id = u.id) as removed
from auth.users u
order by u.created_at;

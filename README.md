# Orbitus Digital Twin

Private workspace for Team N!TRO: team chat, a shared calendar and a shared
missions checklist. Members only.

## How it is kept private

- Everyone signs in with an email and password. There is no sign-up page.
- The data lives in a Supabase database. The rules in `supabase/setup.sql`
  only let people on the `team_members` list read or write anything.
- Search engines are told not to list the site.

Hiding the link is not what protects it. The login is.

## One-time setup

1. **Supabase project.** Create a free project at supabase.com.
2. **Database.** Open SQL Editor, paste all of `supabase/setup.sql`, press Run.
3. **Turn off sign-ups.** Authentication → Sign In / Providers → switch off
   "Allow new users to sign up".
4. **Add the team.** Authentication → Users → Add user, once per teammate
   (email + a starting password, tick "Auto confirm user").
5. **Team list.** Table Editor → `team_members` → add a row with each of the
   same emails.
6. **Connect the app.** Project Settings → API. Copy the Project URL and the
   `anon` `public` key into `config.js`.
7. **Host it.** Import this repository into Vercel as a new project (no build
   settings needed) and give it an address.

Each teammate can change their name and password from the account button
after signing in.

## Demo mode

While `config.js` is empty the app runs with sample data saved only in the
browser, so the screens can be tried before anything is connected.

## Files

- `index.html`, `app.css`, `app.js`: the app
- `config.js`: Supabase connection settings
- `supabase/setup.sql`: tables and privacy rules
- `vendor/`: Supabase browser library (v2.119.0)
- `vercel.json`: security headers

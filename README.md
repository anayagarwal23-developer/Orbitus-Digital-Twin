# Orbitus Digital Twin

Private workspace for Team N!TRO. Members only.

- **Chat:** replies, emoji reactions, @mentions, photos and files (up to 10 MB),
  and an unread count in the browser tab.
- **Calendar:** shared events you can edit, mission due dates shown on the
  days, and export to Google or Apple Calendar (.ics file).
- **Missions:** shared checklist with categories, owners and due dates.
- **Settings:** display name, password change, team list, sign out.
- **Forgot password** link on the sign-in screen.
- **Installable app:** add it to a phone home screen or computer. Settings has
  the steps for each device.

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
7. **Reset emails.** Authentication → URL Configuration: set Site URL to the
   app's address and add the same address under Redirect URLs.
8. **Host it.** Import this repository into Vercel as a new project (no build
   settings needed) and give it an address.

Each teammate can change their name and password from the account button
after signing in.

## Demo mode

While `config.js` is empty the app runs with sample data saved only in the
browser, so the screens can be tried before anything is connected.

## Files

- `index.html`, `app.css`, `app.js`: the app
- `config.js`: Supabase connection settings
- `supabase/setup.sql`: tables, storage and privacy rules (everything)
- `supabase/upgrade-1.sql`: the same additions for a project set up before them
- `vendor/`: Supabase browser library (v2.119.0)
- `manifest.webmanifest`, `sw.js`, `icons/`: what makes it installable
- `vercel.json`: security headers

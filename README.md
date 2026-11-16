# Orbitus Digital Twin

Private workspace for Team N!TRO. Members only.

- **Home:** countdown to the next competition, what is coming up, and your own missions.
- **Chat:** replies, reactions, @mentions, photos and files, polls, pinned
  messages, search, editing your own messages, "seen by", and phone notifications.
- **Calendar:** shared events (one-off or repeating), mission due dates, and
  export to Google or Apple Calendar.
- **Missions:** shared checklist with categories, owners and due dates.
- **Car log:** test runs with track time, car version and parts, a chart, best
  time per car version, and export to a spreadsheet (CSV).
- **Budget:** money in and out with receipts, spending by category, and export
  to a spreadsheet (CSV).
- **Files:** shared documents in folders, up to 25 MB each.
- **Settings:** profile photo, display name, notifications, password, install,
  and a downloadable backup of the team's records.
- **Installable app** on phones and computers.

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

## Notifications

Each person turns them on per device in Settings → Notifications. On iPhone and
iPad the app has to be on the home screen first. The key pair used to send them
is created automatically the first time someone turns notifications on and is
stored in the `push_keys` table, readable by the team only.

## Demo mode

While `config.js` is empty the app runs with sample data saved only in the
browser, so the screens can be tried before anything is connected.

## Files

- `index.html`, `app.css`, `app.js`: the app
- `config.js`: Supabase connection settings
- `supabase/setup.sql`: tables, storage and privacy rules (everything)
- `supabase/upgrade-1.sql`, `supabase/upgrade-2.sql`: the later additions, for a
  project that was set up before them (run in order, each is safe to repeat)
- `api/push.js`: the small function that sends phone notifications
- `vendor/`: Supabase browser library (v2.119.0)
- `manifest.webmanifest`, `sw.js`, `icons/`: what makes it installable
- `vercel.json`: security headers

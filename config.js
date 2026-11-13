/* Orbitus connection settings.
   Both values come from the Supabase dashboard (Project Settings → API).
   The anon key is meant to be public: the database rules in supabase/setup.sql
   are what keep the data private. Leave both empty to run in demo mode. */
window.ORBITUS_CONFIG = {
  url: "",
  anonKey: ""
};

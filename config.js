/* Orbitus connection settings.
   Both values come from the Supabase dashboard (Project Settings → API).
   The anon key is meant to be public: the database rules in supabase/setup.sql
   are what keep the data private. Leave both empty to run in demo mode.
   Read by the browser and by the notification function in api/push.js. */
(function (config) {
  if (typeof module !== "undefined" && module.exports) module.exports = config;
  else window.ORBITUS_CONFIG = config;
})({
  url: "https://kbgbktalslrytimtaqro.supabase.co",
  anonKey: "sb_publishable_hdI60gof75S45Qk_xpyCRg_aICV801W"
});

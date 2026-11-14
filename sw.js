/* Orbitus service worker: keeps the app's own files on the device so it
   opens like an app. Always tries the network first, so updates show up
   straight away; the saved copy is only used when there is no connection.
   Team data (messages, events, files) comes from Supabase and is never saved here. */
var CACHE = "orbitus-shell-v2";
var SHELL = ["/", "/index.html", "/app.css", "/app.js", "/config.js", "/vendor/supabase-2.119.0.js",
  "/favicon.svg", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png",
  "/fonts/archivo-latin.woff2", "/fonts/jetbrains-mono-latin.woff2"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(req).then(function (res) {
    if (res.ok && res.type === "basic") {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req.mode === "navigate" ? "/" : req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req.mode === "navigate" ? "/" : req, { ignoreSearch: req.mode === "navigate" });
  }));
});

/* Orbitus service worker: keeps the app's own files on the device so it
   opens like an app. Always tries the network first, so updates show up
   straight away; the saved copy is only used when there is no connection.
   Team data (messages, events, files) comes from the database and is never saved here. */
var CACHE = "orbitus-shell-v18";
var SHELL = ["/", "/index.html", "/app.css", "/app.js", "/config.js", "/vendor/client-2.119.0.js",
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

/* Phone notifications: sent by api/push.js when a teammate posts. */
self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (wins) {
    // no need to interrupt someone who is already looking at Orbitus
    if (wins.some(function (w) { return w.visibilityState === "visible" && w.focused; })) return;
    return self.registration.showNotification(d.title || "Orbitus", {
      body: d.body || "New message", icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
      tag: d.tag || "orbitus", renotify: true, data: { url: d.url || "/" }
    });
  }));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (wins) {
    for (var i = 0; i < wins.length; i++) if ("focus" in wins[i]) { wins[i].navigate(url).catch(function () {}); return wins[i].focus(); }
    return self.clients.openWindow(url);
  }));
});

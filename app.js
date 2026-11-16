/* Orbitus Digital Twin: the team's private workspace. Chat, calendar,
   missions, car log, budget and files.
   Data lives in Supabase (see supabase/setup.sql). With no config it runs
   in demo mode, saving sample data in this browser only. */
(function () {
  "use strict";

  var CORE = ["profiles", "messages", "events", "missions", "reactions"];
  // added by supabase/upgrade-2.sql; the app still opens if they are not there yet
  var EXTRA = ["poll_votes", "reads", "runs", "ledger", "files", "settings", "push_subscriptions"];
  var TABLES = CORE.concat(EXTRA);
  var TABS = [["home", "Home"], ["chat", "Chat"], ["calendar", "Calendar"], ["missions", "Missions"],
    ["car", "Car log"], ["budget", "Budget"], ["files", "Files"], ["settings", "Settings"]];
  var CATEGORIES = ["Design", "Manufacturing", "Enterprise", "Portfolio"];
  var FOLDERS = ["Portfolio", "Design", "Engineering", "Enterprise", "Other"];
  var LEDGER_CATS = ["Sponsorship", "Materials", "Manufacturing", "Travel", "Registration", "Marketing", "Other"];
  var REPEATS = { weekly: "Weekly", fortnightly: "Every 2 weeks", monthly: "Monthly" };
  var EMOJI = ["👍", "❤️", "😂", "🎉", "🔥", "👀"];
  var INLINE_IMAGES = /^image\/(png|jpe?g|gif|webp|avif)$/;
  var MAX_FILE = 10 * 1024 * 1024;     // chat attachments and receipts
  var MAX_DOC = 25 * 1024 * 1024;      // Files tab
  var TITLE = "Orbitus";

  // read before the Supabase client tidies the address bar
  var startHash = location.hash;
  var recovering = /type=recovery/.test(startHash);
  var linkError = (startHash.match(/error_description=([^&]+)/) || [])[1];

  // installable app: offline helper plus the browser's install offer
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); });
  }
  var installOffer = null;
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); installOffer = e; paintInstall(); });
  window.addEventListener("appinstalled", function () { installOffer = null; paintInstall(); });

  var cfg = window.ORBITUS_CONFIG || {};
  var store = cfg.url && cfg.anonKey ? supaStore(cfg) : demoStore();
  var app = document.getElementById("app");

  var startTab = new URLSearchParams(location.search).get("tab");
  var state = {
    user: null,
    tab: TABS.some(function (t) { return t[0] === startTab; }) ? startTab : "home",
    profiles: [], messages: [], events: [], missions: [], reactions: [],
    poll_votes: [], reads: [], runs: [], ledger: [], files: [], settings: [], push_subscriptions: [],
    missing: {},
    month: startOfMonth(new Date()),
    day: ymd(new Date()),
    filter: "open",
    cat: "all",
    folder: "all",
    openMsg: null,
    replyTo: null,
    editing: null,
    file: null,
    search: "",
    pinnedOnly: false,
    urls: {}
  };
  var ui = {};          // live references to the parts of the shell that re-render
  var stopWatching = null;

  /* ---------- tiny helpers ---------- */
  function h(tag, attrs) {
    var el = document.createElement(tag), k, v;
    for (k in attrs || {}) {
      v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(function (k) { add(el, k); });
    else el.append(kid.nodeType ? kid : String(kid));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function fromYmd(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function fmtDay(s, long) {
    return fromYmd(s).toLocaleDateString("en-GB", long
      ? { weekday: "long", day: "numeric", month: "long" }
      : { weekday: "short", day: "numeric", month: "short" });
  }
  function fmtTime(d) { return new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  function fmtSize(n) { return n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
  function nameOf(id) {
    for (var i = 0; i < state.profiles.length; i++) if (state.profiles[i].id === id) return state.profiles[i].name;
    return "Someone";
  }
  function byId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  var toastTimer;
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg; t.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("on"); }, 3200);
  }
  // turn a thrown error into words a person can act on
  function explain(err, fallback) {
    var m = (err && err.message) || "";
    if (navigator.onLine === false || /failed to fetch|networkerror|load failed|network request failed/i.test(m)) return "No connection. Check your internet and try again.";
    return m || fallback || "Something went wrong. Try again.";
  }
  function fail(err) { toast(explain(err)); }
  function seenKey() { return "orbitus-seen-" + (state.user ? state.user.id : ""); }
  function getSeen() { try { return +localStorage.getItem(seenKey()) || 0; } catch (e) { return 0; } }
  function setSeen(id) { try { localStorage.setItem(seenKey(), String(id)); } catch (e) {} }
  function tidyAddress() { if (location.hash) history.replaceState(null, "", location.pathname + location.search); }
  function passwordFields(labels) {
    var inputs = labels.map(function (l, i) {
      return h("input", { type: "password", id: "pw" + i, autocomplete: l.auto, minlength: l.min || null });
    });
    var show = h("input", { type: "checkbox", id: "pwShow" + labels.length, onchange: function () {
      inputs.forEach(function (i) { i.type = show.checked ? "text" : "password"; });
    } });
    var nodes = [];
    labels.forEach(function (l, i) { nodes.push(h("label", { for: "pw" + i }, l.text), inputs[i]); });
    nodes.push(h("label", { class: "check", for: "pwShow" + labels.length }, show, "Show passwords"));
    return { inputs: inputs, nodes: nodes };
  }
  function say(el, text, good) { el.textContent = text; el.classList.toggle("ok", !!good); }

  /* ---------- shared helpers for the newer sections ---------- */
  function svg(tag, attrs) {
    var el = document.createElementNS("http://www.w3.org/2000/svg", tag), k;
    for (k in attrs || {}) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    for (var i = 2; i < arguments.length; i++) if (arguments[i] != null) el.append(arguments[i]);
    return el;
  }
  function today() { return ymd(new Date()); }
  function money(n) {
    var v = Number(n), whole = Math.round(v * 100) % 100 === 0;
    return "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  }
  function daysUntil(day) { return Math.round((fromYmd(day) - fromYmd(today())) / 86400000); }
  function setting(key) {
    for (var i = 0; i < state.settings.length; i++) if (state.settings[i].key === key) return state.settings[i].value;
    return null;
  }
  // true once supabase/upgrade-2.sql has been run
  function upgraded() { return !state.missing.settings; }
  function notice() {
    return h("p", { class: "notice" }, "This section needs the latest database update. Run supabase/upgrade-2.sql in Supabase to switch it on.");
  }
  function b64ToBytes(s) {
    var b = atob((s + "===".slice((s.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }
  function avatar(id, cls) {
    var p = byId(state.profiles, id), url = p && p.avatar_path && state.urls[p.avatar_path];
    if (url) return h("img", { class: "av " + (cls || ""), src: url, alt: "" });
    return h("b", { class: "av " + (cls || "") }, (p ? p.name : "?").charAt(0).toUpperCase());
  }
  // crop a chosen photo to a small square so profile pictures stay light
  function squareJpeg(file, size) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var c = document.createElement("canvas"), s = Math.min(img.width, img.height);
        c.width = c.height = size;
        c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) {
          if (b) resolve(new File([b], "avatar.jpg", { type: "image/jpeg" }));
          else reject(new Error("Could not read that photo."));
        }, "image/jpeg", 0.86);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("That file is not a photo we can use.")); };
      img.src = url;
    });
  }

  function saveText(name, text, type) {
    var blob = new Blob([text], { type: type });
    var a = h("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  // spreadsheet-friendly: quoted where needed, and cells that look like formulas are defused
  function csv(rows) {
    return "\ufeff" + rows.map(function (r) {
      return r.map(function (v) {
        var t = v == null ? "" : String(v);
        if (/^[=+\-@]/.test(t) && isNaN(Number(t))) t = "'" + t;
        return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
      }).join(",");
    }).join("\r\n") + "\r\n";
  }

  /* private files are opened through short-lived links; fetch them in one go */
  function allPaths() {
    var out = [];
    [state.messages, state.ledger, state.files].forEach(function (list) {
      list.forEach(function (r) { if (r.file_path) out.push(r.file_path); });
    });
    state.profiles.forEach(function (p) { if (p.avatar_path) out.push(p.avatar_path); });
    return out;
  }
  function repaintMedia() { paintAccount(); paintChat(); paintBudget(); paintFiles(); paintSettings(); }
  function fetchUrls() {
    var need = allPaths().filter(function (p, i, a) { return !(p in state.urls) && a.indexOf(p) === i; });
    if (!need.length) return;
    need.forEach(function (p) { state.urls[p] = null; });
    store.fileUrls(need).then(function (map) {
      Object.keys(map).forEach(function (p) { state.urls[p] = map[p]; });
      repaintMedia();
    }).catch(function () { need.forEach(function (p) { delete state.urls[p]; }); });
  }
  function renewUrls() {
    var paths = Object.keys(state.urls);
    if (!paths.length || !state.user) return;
    store.fileUrls(paths).then(function (map) {
      Object.keys(map).forEach(function (p) { state.urls[p] = map[p]; });
      repaintMedia();
    }).catch(function () {});
  }
  function fileLink(path, label, cls) {
    var url = state.urls[path];
    return h("a", { class: cls || "btn sm", href: url || null, target: "_blank", rel: "noopener noreferrer", "aria-disabled": url ? null : "true" }, label);
  }
  function removeStored(path) { if (path) store.removeFile(path).catch(function () {}); }

  /* ---------- boot ---------- */
  store.session().then(function (user) {
    if (user && recovering) { if (!ui.recovery) newPassword(); return; }
    tidyAddress();
    if (user) enter(user);
    else showLogin(linkError ? "That reset link has expired or was already used. Ask for a new one." : "");
  }).catch(function () { showLogin(); });

  store.onAuth(function (ev) {
    if (ev === "PASSWORD_RECOVERY" && !ui.recovery) newPassword();
    if (ev === "SIGNED_OUT" && state.user) { leave(); showLogin("You have been signed out."); }
  });

  function card(kids) {
    return h("main", { class: "login" }, kids, h("p", { class: "mono dim" }, "Members only"));
  }
  function wordmark() { return h("h1", { class: "wordmark", "aria-label": "Orbitus" }, "ORB", h("i", null, "!"), "TUS"); }

  /* ---------- login ---------- */
  function showLogin(note, presetEmail) {
    document.title = TITLE;
    var email = h("input", { type: "email", id: "email", autocomplete: "username", required: true, placeholder: "you@example.com", value: presetEmail || null });
    var pass = h("input", { type: "password", id: "pass", autocomplete: "current-password", required: true, placeholder: "Password" });
    var msg = h("p", { class: "form-msg", role: "alert" }, note || "");
    var btn = h("button", { class: "btn primary", type: "submit" }, "Sign in");
    var form = h("form", { class: "login-card", novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      if (!email.value.trim() || !pass.value) { msg.textContent = "Enter your email and password."; return; }
      btn.disabled = true; btn.textContent = "Signing in…"; msg.textContent = "";
      store.signIn(email.value.trim(), pass.value).then(enter).catch(function (err) {
        btn.disabled = false; btn.textContent = "Sign in";
        msg.textContent = /invalid/i.test(err.message || "") ? "That email or password is not right." : explain(err, "Could not sign in.");
      });
    } },
      wordmark(),
      h("p", { class: "mono sub" }, "Digital twin"),
      h("label", { for: "email" }, "Email"), email,
      h("label", { for: "pass" }, "Password"), pass,
      btn,
      h("button", { class: "linkish", type: "button", onclick: function () { showForgot(email.value.trim()); } }, "Forgot password?"),
      msg,
      !isInstalled() && h("div", { class: "dl-login" }, downloadButton("ghost")),
      store.demo && h("p", { class: "demo-note" }, "Demo mode: not connected yet. Any email and password opens a sample workspace that is saved only in this browser.")
    );
    clear(app).append(card(form));
    (presetEmail ? pass : email).focus();
  }

  function showForgot(preset) {
    var email = h("input", { type: "email", id: "fEmail", autocomplete: "username", required: true, placeholder: "you@example.com", value: preset || null });
    var msg = h("p", { class: "form-msg", role: "status" });
    var btn = h("button", { class: "btn primary", type: "submit" }, "Send reset link");
    clear(app).append(card(h("form", { class: "login-card", novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      var v = email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { say(msg, "Enter the email you sign in with."); return; }
      btn.disabled = true; say(msg, "");
      store.resetPassword(v, location.origin + location.pathname).then(function () {
        say(msg, "If that email is on the team, a reset link is on its way. Check your spam folder too.", true);
      }, function (err) {
        btn.disabled = false;
        say(msg, /rate|seconds/i.test(err.message || "") ? "Too many reset emails. Wait a few minutes and try again." : explain(err, "Could not send the email."));
      });
    } },
      wordmark(),
      h("h2", { class: "card-h" }, "Reset your password"),
      h("p", { class: "dim small" }, "We will email you a link to choose a new password."),
      h("label", { for: "fEmail" }, "Email"), email,
      btn, msg,
      h("button", { class: "linkish", type: "button", onclick: function () { showLogin("", email.value.trim()); } }, "Back to sign in"))));
    email.focus();
  }

  function newPassword() {
    ui.recovery = true;
    var f = passwordFields([{ text: "New password", auto: "new-password", min: 8 }, { text: "New password again", auto: "new-password", min: 8 }]);
    var msg = h("p", { class: "form-msg", role: "status" });
    var btn = h("button", { class: "btn primary", type: "submit" }, "Save new password");
    clear(app).append(card(h("form", { class: "login-card", novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      var a = f.inputs[0].value, b = f.inputs[1].value;
      if (a.length < 8) { say(msg, "Use at least 8 characters."); return; }
      if (a !== b) { say(msg, "The two passwords do not match."); return; }
      btn.disabled = true; say(msg, "");
      store.setPassword(a).then(function () { return store.session(); }).then(function (user) {
        ui.recovery = false; tidyAddress(); toast("Password changed."); enter(user);
      }, function (err) { btn.disabled = false; say(msg, explain(err, "Could not save the password.")); });
    } },
      wordmark(),
      h("h2", { class: "card-h" }, "Choose a new password"),
      f.nodes, btn, msg)));
    f.inputs[0].focus();
  }

  /* ---------- entering / leaving the workspace ---------- */
  function enter(user) {
    state.user = user;
    clear(app).append(h("p", { class: "boot" }, "Loading…"));
    return store.isTeam().then(function (ok) {
      if (!ok) {
        return store.signOut().then(function () {
          state.user = null;
          showLogin("This account is not on the team list.");
        });
      }
      return Promise.all(TABLES.map(load)).then(function () {
        if (!state.profiles.some(function (p) { return p.id === user.id; })) return askName();
        buildShell();
      });
    }).catch(function (err) {
      state.user = null;
      showLogin(explain(err, "Could not load the workspace."));
    });
  }
  function leave() {
    if (stopWatching) { stopWatching(); stopWatching = null; }
    state.user = null; state.replyTo = null; state.editing = null; state.file = null; state.urls = {};
    state.search = ""; state.pinnedOnly = false; ui = {};
    document.title = TITLE;
    try { if (navigator.clearAppBadge) navigator.clearAppBadge().catch(function () {}); } catch (e) {}
  }
  function load(table) {
    return store.list(table).then(function (rows) {
      state[table] = rows; delete state.missing[table];
    }, function (err) {
      // the newer tables are optional until the database update has been run
      if (EXTRA.indexOf(table) < 0) throw err;
      state[table] = []; state.missing[table] = true;
    });
  }
  function refresh(table) {
    if (!state.user) return;
    load(table).then(function () { paint(table); }).catch(function () {});
  }

  function askName() {
    var input = h("input", { type: "text", id: "nm", maxlength: 40, required: true, autocomplete: "given-name", placeholder: "First name" });
    var msg = h("p", { class: "form-msg", role: "alert" });
    clear(app).append(h("main", { class: "login" }, h("form", { class: "login-card", onsubmit: function (e) {
      e.preventDefault();
      var name = input.value.trim();
      if (!name) { msg.textContent = "Add a name."; return; }
      store.saveName(state.user.id, name).then(function () { return load("profiles"); }).then(buildShell)
        .catch(function (err) { msg.textContent = explain(err, "Could not save."); });
    } },
      wordmark(),
      h("label", { for: "nm" }, "What should the team call you?"), input,
      h("button", { class: "btn primary", type: "submit" }, "Continue"), msg)));
    input.focus();
  }

  /* ---------- shell ---------- */
  var ICONS = {
    home: "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
    chat: "M4 5h16v11H9l-5 4z",
    calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
    missions: "M4 6l2 2 3-3M4 13l2 2 3-3M13 7h7M13 14h7M4 20h16",
    car: "M12 9v4l2.5 2M9.5 3h5M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z",
    budget: "M4 7h16v12H4zM4 11h16M8 15h3",
    files: "M4 6h6l2 2h8v11H4z",
    settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    clip: "M16.5 7.5l-7.8 7.8a2.1 2.1 0 0 0 3 3l8.1-8.1a4.2 4.2 0 0 0-6-6L5.6 12.4a6.3 6.3 0 0 0 8.9 8.9l6-6",
    edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
    download: "M12 4v11M7 10l5 5 5-5M5 20h14",
    file: "M7 3h7l5 5v13H7zM14 3v5h5",
    poll: "M6 20V11M12 20V4M18 20v-6",
    pin: "M9 4h6l-1 6 3 3v2H7v-2l3-3zM12 15v6",
    search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16.5 16.5L21 21"
  };
  function icon(name) {
    var ns = "http://www.w3.org/2000/svg";
    var el = document.createElementNS(ns, "svg"), p = document.createElementNS(ns, "path");
    el.setAttribute("viewBox", "0 0 24 24"); el.setAttribute("aria-hidden", "true");
    if (name === "more") el.setAttribute("class", "dots-icon");
    p.setAttribute("d", ICONS[name]); el.append(p);
    return el;
  }
  function iconBtn(name, label, onclick) {
    return h("button", { class: "ibtn", type: "button", "aria-label": label, title: label, onclick: onclick }, icon(name));
  }

  function buildShell() {
    ui = {};
    ui.tabs = {};
    ui.views = {
      home: homeView(), chat: chatView(), calendar: calendarView(), missions: missionsView(),
      car: carView(), budget: budgetView(), files: filesView(), settings: settingsView(), more: moreView()
    };
    var nav = h("nav", { class: "tabs", "aria-label": "Sections" }, TABS.map(function (t, i) {
      var dot = t[0] === "chat" ? (ui.unread = h("b", { class: "unread", hidden: true })) : null;
      return (ui.tabs[t[0]] = h("button", { type: "button", class: i > 3 ? "extra" : null, onclick: function () { go(t[0]); } },
        icon(t[0]), h("span", null, t[1]), dot));
    }), (ui.moreBtn = h("button", { type: "button", class: "more-btn", onclick: function () { go("more"); } }, icon("more"), h("span", null, "More"))));
    ui.acct = h("button", { class: "acct", type: "button", onclick: function () { go("settings"); }, "aria-label": "Settings" });
    clear(app).append(h("div", { class: "shell" },
      h("header", { class: "brand" }, h("div", { class: "wordmark sm" }, "ORB", h("i", null, "!"), "TUS"), h("p", { class: "mono sub" }, "Digital twin")),
      ui.acct, nav,
      h("main", { class: "main" },
        store.demo && h("p", { class: "demo-bar mono" }, "Demo mode · saved in this browser only"),
        (ui.netBar = h("p", { class: "demo-bar mono", role: "status", hidden: navigator.onLine !== false }, "You are offline · changes will not save until you reconnect")),
        TABS.map(function (t) { return ui.views[t[0]]; }), ui.views.more)));
    ["profiles", "messages", "push_subscriptions"].forEach(paint);
    go(state.tab);
    if (stopWatching) stopWatching();
    var unwatch = store.watch(refresh);
    var wake = function () { if (!document.hidden && state.tab === "chat") markSeen(); };
    document.addEventListener("visibilitychange", wake);
    var urlTimer = setInterval(renewUrls, 45 * 60 * 1000);   // file links last an hour
    var net = function () {
      if (ui.netBar) ui.netBar.hidden = navigator.onLine !== false;
      if (navigator.onLine !== false) TABLES.forEach(refresh);   // catch up on what was missed
    };
    window.addEventListener("online", net); window.addEventListener("offline", net);
    stopWatching = function () {
      unwatch(); document.removeEventListener("visibilitychange", wake); clearInterval(urlTimer);
      window.removeEventListener("online", net); window.removeEventListener("offline", net);
    };
  }

  function go(tab) {
    state.tab = tab;
    Object.keys(ui.views).forEach(function (t) { ui.views[t].hidden = t !== tab; });
    var inMore = tab === "more";
    TABS.forEach(function (t, i) {
      if (t[0] === tab) { ui.tabs[t[0]].setAttribute("aria-current", "page"); if (i > 3) inMore = true; }
      else ui.tabs[t[0]].removeAttribute("aria-current");
    });
    if (inMore) ui.moreBtn.setAttribute("aria-current", "page"); else ui.moreBtn.removeAttribute("aria-current");
    if (tab === "chat") { markSeen(); scrollChat(); }
    if (tab === "home") paintHome();
  }

  function paint(table) {
    if (!ui.views) return;
    if (table === "profiles") {
      paintAccount(); paintChat(); paintCalendar(); paintMissions(); paintOwners(); paintSettings();
      paintHome(); paintCar(); paintBudget(); paintFiles();
    }
    if (table === "messages" || table === "reactions" || table === "poll_votes" || table === "reads") paintChat();
    if (table === "messages") paintHome();
    if (table === "events") { paintCalendar(); paintHome(); }
    if (table === "missions") { paintMissions(); paintCalendar(); paintHome(); }
    if (table === "runs") { paintCar(); paintHome(); }
    if (table === "ledger") { paintBudget(); paintHome(); }
    if (table === "files") paintFiles();
    if (table === "settings") paintHome();
    if (table === "push_subscriptions") paintPush();
  }
  function paintAccount() {
    if (!ui.acct) return;
    clear(ui.acct).append(avatar(state.user.id), h("span", null, nameOf(state.user.id)));
  }

  /* ---------- home ---------- */
  function homeView() {
    ui.hello = h("h1");
    ui.count = h("div", { class: "card count" });
    ui.homeUpdate = h("div", { class: "card update", hidden: true });
    ui.homeEvents = h("ul", { class: "ev-list" });
    ui.homeMissions = h("ul", { class: "m-list compact" });
    ui.homeStats = h("div", { class: "stat-row" });
    return h("section", { class: "view home", "aria-label": "Home", hidden: true },
      h("header", { class: "view-h" }, ui.hello,
        h("p", { class: "mono dim" }, new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }))),
      ui.homeUpdate, ui.count, ui.homeStats,
      h("div", { class: "set-grid" },
        h("div", { class: "card" }, h("h2", null, "Next up"), ui.homeEvents,
          h("div", { class: "row" }, h("button", { class: "btn sm", type: "button", onclick: function () { go("calendar"); } }, "Open calendar"))),
        h("div", { class: "card" }, h("h2", null, "Your missions"), ui.homeMissions,
          h("div", { class: "row" }, h("button", { class: "btn sm", type: "button", onclick: function () { go("missions"); } }, "Open missions")))));
  }
  function editCompetition() {
    var c = setting("competition") || {};
    var name = h("input", { type: "text", id: "cName", maxlength: 80, value: c.name || null, placeholder: "e.g. National Finals" });
    var date = h("input", { type: "date", id: "cDate", value: c.date || null });
    sheet("Next competition", [
      h("label", { for: "cName" }, "Name"), name,
      h("label", { for: "cDate" }, "Date (leave empty to clear)"), date
    ], function () {
      if (date.value && !name.value.trim()) return "Give it a name.";
      return store.upsert("settings", { key: "competition", value: { name: name.value.trim(), date: date.value }, updated_at: new Date().toISOString() }, "key")
        .then(function () { refresh("settings"); });
    });
  }
  // shown until supabase/upgrade-2.sql has been run: three clicks for whoever holds the Supabase login
  var updateSql = null;
  function paintUpdate() {
    var box = ui.homeUpdate;
    box.hidden = store.demo || upgraded();
    if (box.hidden || box.firstChild) return;
    var ref = (cfg.url.match(/^https:\/\/([^.]+)\./) || [])[1];
    var copy = h("button", { class: "btn primary", type: "button", disabled: true, onclick: function () {
      navigator.clipboard.writeText(updateSql).then(function () { copy.textContent = "Copied ✓"; }, function () { toast("Could not copy. Open supabase/upgrade-2.sql in the repo instead."); });
    } }, "1 · Copy the update");
    fetch("/supabase/upgrade-2.sql").then(function (r) { if (!r.ok) throw 0; return r.text(); })
      .then(function (t) { updateSql = t; copy.disabled = false; }).catch(function () {});
    box.append(
      h("p", { class: "mono" }, "One step left"),
      h("h2", null, "Switch on the new sections"),
      h("p", { class: "dim" }, "Car log, Budget, Files, polls, pins, photos and notifications need a one-time database update. Whoever set up Orbitus in Supabase can do it in under a minute."),
      h("div", { class: "row" }, copy,
        ref && h("a", { class: "btn", href: "https://supabase.com/dashboard/project/" + ref + "/sql/new", target: "_blank", rel: "noopener noreferrer" }, "2 · Open Supabase"),
        h("button", { class: "btn", type: "button", onclick: function () { location.reload(); } }, "3 · Done, reload")),
      h("p", { class: "dim small" }, "In Supabase: paste, press Run, and confirm if it warns you. It should say Success."));
  }
  function stat(value, label, tab) {
    return h("button", { class: "stat", type: "button", onclick: function () { go(tab); } }, h("b", null, value), h("span", { class: "mono" }, label));
  }
  function paintHome() {
    if (!ui.hello) return;
    var me = state.user.id, t = today();
    ui.hello.textContent = "Hi, " + nameOf(me);
    paintUpdate();

    var c = setting("competition"), n = c && c.date ? daysUntil(c.date) : null;
    clear(ui.count);
    if (n === null) add(ui.count, [
      h("div", null, h("p", { class: "mono" }, "Competition countdown"), h("p", { class: "dim" }, "Set the date of your next competition and the whole team sees the countdown here.")),
      upgraded() && h("button", { class: "btn primary", type: "button", onclick: editCompetition }, "Set the date")]);
    else ui.count.append(
      h("div", { class: "count-n" }, h("b", null, n > 1 ? n : n === 1 ? "1" : n === 0 ? "Today" : Math.abs(n)),
        n !== 0 && h("span", { class: "mono" }, n > 1 ? "days to go" : n === 1 ? "day to go" : n === -1 ? "day ago" : "days ago")),
      h("div", null, h("p", { class: "mono" }, "Next competition"), h("h2", null, c.name || "Competition"), h("p", { class: "dim" }, fmtDay(c.date, true))),
      h("button", { class: "btn sm", type: "button", onclick: editCompetition }, "Change"));

    var unread = state.messages.filter(function (m) { return m.id > getSeen() && m.user_id !== me; }).length;
    var open = state.missions.filter(function (m) { return !m.done; }).length;
    var best = state.runs.reduce(function (b, r) { return b === null || +r.time_s < b ? +r.time_s : b; }, null);
    clear(ui.homeStats).append(
      stat(unread, unread === 1 ? "new message" : "new messages", "chat"),
      stat(open, open === 1 ? "open mission" : "open missions", "missions"),
      stat(best === null ? "—" : best.toFixed(3) + "s", "best track time", "car"));
    if (state.ledger.length) {
      var left = state.ledger.reduce(function (sum, r) { return sum + (r.kind === "in" ? 1 : -1) * r.amount; }, 0);
      ui.homeStats.append(stat((left < 0 ? "−" : "") + money(Math.abs(left)), "left to spend", "budget"));
    }

    clear(ui.homeEvents);
    var next = upcoming(t, 120, 3);
    if (!next.length) ui.homeEvents.append(h("li", { class: "empty" }, "Nothing in the calendar yet."));
    next.forEach(function (x) { ui.homeEvents.append(evItem(x.ev, true, x.day)); });

    clear(ui.homeMissions);
    var mine = state.missions.filter(function (m) { return !m.done && m.owner === me; }).sort(missionSort).slice(0, 5);
    if (!mine.length) ui.homeMissions.append(h("li", { class: "empty" }, "Nothing assigned to you right now."));
    mine.forEach(function (m) { ui.homeMissions.append(missionItem(m)); });
  }

  /* ---------- more (phones) ---------- */
  function moreView() {
    return h("section", { class: "view more", "aria-label": "More", hidden: true },
      h("header", { class: "view-h" }, h("h1", null, "More")),
      h("div", { class: "more-list" }, TABS.slice(4).map(function (t) {
        return h("button", { type: "button", onclick: function () { go(t[0]); } }, icon(t[0]), h("span", null, t[1]), h("i", { "aria-hidden": "true" }, "→"));
      })));
  }

  /* ---------- editor sheet (events and missions) ---------- */
  function sheet(title, body, onSave, saveLabel) {
    var msg = h("p", { class: "form-msg", role: "alert" });
    var dlg = h("dialog", { class: "sheet" });
    function close() { dlg.close(); dlg.remove(); }
    dlg.append(h("form", { novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      var r = onSave();
      if (typeof r === "string") { say(msg, r); return; }
      r.then(close, function (err) { say(msg, explain(err, "Could not save.")); });
    } },
      h("h2", null, title), body, msg,
      h("div", { class: "row" },
        h("button", { class: "btn primary", type: "submit" }, saveLabel || "Save"),
        h("button", { class: "btn", type: "button", onclick: close }, "Cancel"))));
    dlg.addEventListener("cancel", function () { dlg.remove(); });
    document.body.append(dlg); dlg.showModal();
    var first = dlg.querySelector("input");
    if (first) first.focus();
  }
  function categorySelect(id, value) {
    var s = h("select", { id: id, "aria-label": "Category" }, h("option", { value: "" }, "General"),
      CATEGORIES.map(function (c) { return h("option", { value: c }, c); }));
    s.value = value || "";
    return s;
  }
  function ownerSelect(id, value) {
    var s = h("select", { id: id, "aria-label": "Who owns it" }, h("option", { value: "" }, "Anyone"),
      state.profiles.slice().sort(function (a, b) { return a.name.localeCompare(b.name); })
        .map(function (p) { return h("option", { value: p.id }, p.name); }));
    s.value = value || "";
    return s;
  }
  function editEvent(ev) {
    var title = h("input", { type: "text", id: "eTitle", maxlength: 120, value: ev.title });
    var day = h("input", { type: "date", id: "eDay", value: ev.day });
    var at = h("input", { type: "time", id: "eAt", value: ev.at ? ev.at.slice(0, 5) : null });
    var note = h("input", { type: "text", id: "eNote", maxlength: 500, value: ev.note || null });
    var repeat = repeatSelect("eRepeat", ev.repeat);
    var until = h("input", { type: "date", id: "eUntil", value: ev.repeat_until || null });
    sheet("Edit event", [
      h("label", { for: "eTitle" }, "What"), title,
      h("div", { class: "pair" },
        h("div", null, h("label", { for: "eDay" }, ev.repeat ? "First day" : "Day"), day),
        h("div", null, h("label", { for: "eAt" }, "Time (optional)"), at)),
      h("label", { for: "eNote" }, "Note"), note,
      upgraded() && h("div", { class: "pair" },
        h("div", null, h("label", { for: "eRepeat" }, "Repeats"), repeat),
        h("div", null, h("label", { for: "eUntil" }, "Until (optional)"), until))
    ], function () {
      if (!title.value.trim()) return "Add a title.";
      if (!day.value) return "Pick a day.";
      if (repeat.value && until.value && until.value < day.value) return "The end date is before the first day.";
      var patch = { title: title.value.trim(), day: day.value, at: at.value || null, note: note.value.trim() || null };
      if (upgraded()) { patch.repeat = repeat.value || null; patch.repeat_until = repeat.value && until.value ? until.value : null; }
      return store.update("events", ev.id, patch)
        .then(function () { if (!patch.repeat) { state.day = day.value; state.month = startOfMonth(fromYmd(day.value)); } refresh("events"); });
    });
  }
  function editMission(m) {
    var title = h("input", { type: "text", id: "mTitle", maxlength: 200, value: m.title });
    var cat = categorySelect("mCat", m.category);
    var owner = ownerSelect("mOwner", m.owner);
    var due = h("input", { type: "date", id: "mDue", value: m.due || null });
    sheet("Edit mission", [
      h("label", { for: "mTitle" }, "Mission"), title,
      h("div", { class: "pair" },
        h("div", null, h("label", { for: "mCat" }, "Category"), cat),
        h("div", null, h("label", { for: "mOwner" }, "Owner"), owner)),
      h("label", { for: "mDue" }, "Due (optional)"), due
    ], function () {
      if (!title.value.trim()) return "Add a title.";
      return store.update("missions", m.id, { title: title.value.trim(), category: cat.value || null, owner: owner.value || null, due: due.value || null })
        .then(function () { refresh("missions"); });
    });
  }

  /* ---------- settings ---------- */
  function settingsView() {
    ui.setName = h("input", { type: "text", id: "setName", maxlength: 40, autocomplete: "given-name" });
    ui.team = h("ul", { class: "team-list" });
    ui.photo = h("div", { class: "photo-row" });
    ui.push = h("div", { class: "card" });
    var nameMsg = h("p", { class: "form-msg", role: "status" });
    var f = passwordFields([
      { text: "Current password", auto: "current-password" },
      { text: "New password", auto: "new-password", min: 8 },
      { text: "New password again", auto: "new-password", min: 8 }]);
    var cur = f.inputs[0], pw = f.inputs[1], pw2 = f.inputs[2];
    var pwMsg = h("p", { class: "form-msg", role: "status" });
    var pwBtn = h("button", { class: "btn primary", type: "submit" }, "Change password");
    ui.photoPick = h("input", { type: "file", accept: "image/*", hidden: true, onchange: function () {
      var file = ui.photoPick.files[0]; ui.photoPick.value = "";
      if (!file) return;
      var old = (byId(state.profiles, state.user.id) || {}).avatar_path;
      squareJpeg(file, 256).then(function (small) { return store.upload(state.user.id, small); }).then(function (path) {
        return store.update("profiles", state.user.id, { avatar_path: path });
      }).then(function () { removeStored(old); refresh("profiles"); toast("Photo updated."); }).catch(fail);
    } });

    return h("section", { class: "view settings", "aria-label": "Settings", hidden: true },
      h("header", { class: "view-h" }, h("h1", null, "Settings"), h("p", { class: "mono dim" }, "Your account")),
      h("div", { class: "set-grid" },
        h("form", { class: "card", novalidate: true, onsubmit: function (e) {
          e.preventDefault();
          var n = ui.setName.value.trim();
          if (!n) { say(nameMsg, "Name cannot be empty."); return; }
          store.saveName(state.user.id, n).then(function () { refresh("profiles"); say(nameMsg, "Name saved.", true); })
            .catch(function (err) { say(nameMsg, explain(err, "Could not save.")); });
        } },
          h("h2", null, "Profile"),
          ui.photo, ui.photoPick,
          h("label", null, "Signed in as"), h("p", { class: "set-email" }, state.user.email),
          h("label", { for: "setName" }, "Display name"), ui.setName,
          h("p", { class: "dim small hint" }, "Teammates mention you in chat by typing @ and this name."),
          h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Save name")), nameMsg),

        ui.push,

        (ui.install = h("div", { class: "card" })),

        h("form", { class: "card", novalidate: true, onsubmit: function (e) {
          e.preventDefault();
          if (!cur.value) { say(pwMsg, "Enter your current password."); cur.focus(); return; }
          if (pw.value.length < 8) { say(pwMsg, "The new password needs at least 8 characters."); pw.focus(); return; }
          if (pw.value !== pw2.value) { say(pwMsg, "The two new passwords do not match."); pw2.focus(); return; }
          if (pw.value === cur.value) { say(pwMsg, "Choose a password different from the current one."); pw.focus(); return; }
          pwBtn.disabled = true; say(pwMsg, "");
          store.checkPassword(state.user.email, cur.value).then(function () {
            return store.setPassword(pw.value);
          }).then(function () {
            cur.value = pw.value = pw2.value = "";
            say(pwMsg, "Password changed.", true);
          }, function (err) {
            say(pwMsg, /invalid/i.test(err.message || "") ? "The current password is not right." : explain(err, "Could not change the password."));
          }).then(function () { pwBtn.disabled = false; });
        } },
          h("h2", null, "Password"), f.nodes,
          h("div", { class: "row" }, pwBtn), pwMsg),

        h("div", { class: "card" }, h("h2", null, "Team"), ui.team),

        h("div", { class: "card" },
          h("h2", null, "Backup"),
          h("p", { class: "dim" }, "Download a copy of the team's records: the latest messages, events, missions, car log, budget and the list of files. Uploaded files themselves are not included."),
          h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: function () {
            var out = { app: "Orbitus", exported_at: new Date().toISOString(), exported_by: nameOf(state.user.id) };
            ["profiles", "messages", "reactions", "poll_votes", "events", "missions", "runs", "ledger", "files", "settings"].forEach(function (t) {
              out[t] = state[t].map(function (r) { var c = Object.assign({}, r); delete c.avatar_path; return c; });
            });
            saveText("orbitus-backup-" + today() + ".json", JSON.stringify(out, null, 2), "application/json");
            toast("Backup downloaded. Keep it somewhere private.");
          } }, icon("download"), "Download a backup"))),

        h("div", { class: "card" },
          h("h2", null, "Sign out"),
          h("p", { class: "dim" }, "You will need your email and password to get back in."),
          h("div", { class: "row" }, h("button", { class: "btn danger", type: "button", onclick: function () {
            store.signOut().then(function () { leave(); showLogin(); });
          } }, "Sign out")))));
  }

  /* ---------- download / install ---------- */
  function isInstalled() {
    return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  }
  function platform() {
    var ua = navigator.userAgent;
    var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    var os = ios ? (/iPad/.test(ua) || /Macintosh/.test(ua) ? "iPad" : "iPhone")
      : /Android/.test(ua) ? "Android" : /CrOS/.test(ua) ? "Chromebook" : /Windows/.test(ua) ? "Windows"
      : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "this device";
    var browser = /EdgiOS|EdgA|Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet"
      : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /CriOS|Chrome\//.test(ua) ? "Chrome"
      : /Safari\//.test(ua) ? "Safari" : "your browser";
    return { os: os, browser: browser, ios: ios };
  }
  function downloadLabel() {
    if (isInstalled()) return "Installed on this device";
    var os = platform().os;
    return os === "this device" ? "Download the app" : "Download for " + os;
  }
  function installSteps(pf) {
    if (pf.ios && pf.browser === "Safari") return [
      "Tap the Share button " + (pf.os === "iPad" ? "at the top of the screen" : "at the bottom of the screen") + " (the square with an arrow).",
      "Scroll down and tap Add to Home Screen.",
      "Tap Add. Orbitus appears on your home screen."];
    if (pf.ios) return [
      "Tap the Share button in " + pf.browser + " (in or next to the address bar).",
      "Tap Add to Home Screen, then Add.",
      "Don't see it? Open this page in Safari and try there."];
    if (pf.os === "Mac" && pf.browser === "Safari") return [
      "In the menu bar, click File.",
      "Choose Add to Dock, then Add.",
      "Orbitus appears in your Dock and Launchpad."];
    if (pf.browser === "Firefox" && pf.os !== "Android") return [
      "Firefox on computers can't install apps.",
      "Open this page in Chrome or Edge" + (pf.os === "Mac" ? ", or in Safari" : "") + ".",
      "Then press Download again."];
    if (pf.os === "Android" && pf.browser === "Samsung Internet") return [
      "Tap the menu button (three lines) at the bottom.",
      "Tap Add page to, then Home screen.",
      "Tap Add."];
    if (pf.os === "Android") return [
      "Tap the menu button (three dots) in " + pf.browser + ".",
      "Tap Install app (or Add to Home screen).",
      "Tap Install. Orbitus appears with your other apps."];
    if (pf.browser === "Edge") return [
      "Click the menu (three dots) at the top right.",
      "Choose Apps, then Install this site as an app.",
      "Click Install. Orbitus opens in its own window."];
    return [
      "Click the install icon at the right end of the address bar, or open the menu (three dots).",
      "Choose Cast, save and share, then Install page as app (or just Install Orbitus).",
      "Click Install. Orbitus opens in its own window and appears with your apps."];
  }
  function download() {
    if (isInstalled()) { toast("Orbitus is already installed on this device."); return; }
    if (installOffer) {
      var offer = installOffer; installOffer = null;
      offer.prompt();
      offer.userChoice.then(function (c) { if (c.outcome === "accepted") toast("Installing Orbitus…"); paintInstall(); }, paintInstall);
      return;
    }
    var pf = platform();
    var dlg = h("dialog", { class: "sheet" });
    function close() { dlg.close(); dlg.remove(); }
    dlg.append(
      h("div", { class: "dl-head" }, h("img", { src: "/icons/icon-192.png", alt: "", width: 56, height: 56 }),
        h("div", null, h("h2", null, "Get Orbitus"), h("p", { class: "mono dim" }, pf.os === "this device" ? pf.browser : pf.os + " · " + pf.browser))),
      h("ol", { class: "steps" }, installSteps(pf).map(function (t) { return h("li", null, t); })),
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", onclick: close }, "Done")));
    dlg.addEventListener("cancel", function () { dlg.remove(); });
    document.body.append(dlg); dlg.showModal();
  }
  function downloadButton(cls) {
    var b = h("button", { class: "btn " + (cls || "primary") + " dl-btn", type: "button", onclick: download, disabled: isInstalled() || null }, icon("download"), downloadLabel());
    return b;
  }
  function paintInstall() {
    document.querySelectorAll(".dl-btn").forEach(function (b) {
      b.lastChild.textContent = downloadLabel();
      b.disabled = isInstalled();
    });
    if (!ui.install) return;
    add(clear(ui.install), [h("h2", null, "Get the app"),
      h("p", { class: "dim" }, isInstalled() ? "You are using the installed app." :
        "Install Orbitus so it opens from your home screen or desktop like any other app, with a badge for new messages."),
      !isInstalled() && h("div", { class: "row" }, downloadButton())]);
  }
  function paintSettings() {
    if (!ui.team) return;
    paintInstall();
    var me = state.user.id, mine = byId(state.profiles, me) || {};
    if (document.activeElement !== ui.setName) ui.setName.value = nameOf(me);
    clear(ui.photo).append(avatar(me, "lg"),
      upgraded() ? h("div", { class: "row" },
        h("button", { class: "btn sm", type: "button", onclick: function () { ui.photoPick.click(); } }, mine.avatar_path ? "Change photo" : "Add a photo"),
        mine.avatar_path && h("button", { class: "btn sm danger", type: "button", onclick: function () {
          var old = mine.avatar_path;
          store.update("profiles", me, { avatar_path: null }).then(function () { removeStored(old); refresh("profiles"); }).catch(fail);
        } }, "Remove")) : h("p", { class: "dim small" }, "Profile photos need the latest database update."));
    clear(ui.team);
    state.profiles.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (p) {
      ui.team.append(h("li", null, avatar(p.id), h("span", null, p.name), p.id === me && h("i", { class: "mono" }, "You")));
    });
    fetchUrls();
  }

  /* ---------- phone notifications ---------- */
  function pushSupported() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
  function pushRegistration() {
    return Promise.race([navigator.serviceWorker.ready, new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error("The app is still getting ready. Reload the page and try again.")); }, 6000);
    })]);
  }
  function setPush(mode) {
    return pushRegistration().then(function (reg) {
      return reg.pushManager.getSubscription().then(function (sub) {
        if (mode === "off") {
          if (!sub) return;
          return store.removeWhere("push_subscriptions", { endpoint: sub.endpoint }).then(function () { return sub.unsubscribe(); });
        }
        return Notification.requestPermission().then(function (perm) {
          if (perm !== "granted") throw new Error("Notifications are blocked for Orbitus. Allow them in your browser or phone settings, then try again.");
          return sub || store.pushKey().then(function (key) {
            return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
          });
        }).then(function (s) {
          var j = s.toJSON();
          return store.upsert("push_subscriptions", { endpoint: j.endpoint, user_id: state.user.id, p256dh: j.keys.p256dh, auth: j.keys.auth, mode: mode }, "endpoint");
        });
      });
    });
  }
  function paintPush() {
    if (!ui.push) return;
    var box = clear(ui.push);
    box.append(h("h2", null, "Notifications"));
    if (state.missing.push_subscriptions) { box.append(notice()); return; }
    if (!pushSupported()) {
      box.append(h("p", { class: "dim" }, platform().ios && !isInstalled()
        ? "On iPhone and iPad, notifications work once Orbitus is on your home screen. Install it with the Download button, open it from there, then come back to this screen."
        : "This browser cannot show notifications. Try Chrome, Edge or Safari, or install the app."));
      return;
    }
    var msg = h("p", { class: "form-msg", role: "status" });
    var chips = h("div", { class: "chips", role: "group", "aria-label": "Notify me about" });
    box.append(h("p", { class: "dim" }, "Get a notification on this device when the team posts, even when Orbitus is closed."), chips, msg);
    function draw(current) {
      clear(chips);
      [["off", "Off"], ["mentions", "Mentions only"], ["all", "Every message"]].forEach(function (o) {
        chips.append(h("button", { type: "button", class: "chip mono", "aria-pressed": o[0] === current ? "true" : "false", onclick: function () {
          say(msg, "Saving…", true);
          setPush(o[0]).then(function () {
            draw(o[0]); load("push_subscriptions");
            say(msg, o[0] === "off" ? "Notifications are off on this device." : "Notifications are on for this device.", true);
          }, function (err) { say(msg, explain(err, "Could not change notifications.")); });
        } }, o[1]));
      });
    }
    draw("off");
    pushRegistration().then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      var row = sub && state.push_subscriptions.filter(function (r) { return r.endpoint === sub.endpoint; })[0];
      draw(row && Notification.permission === "granted" ? row.mode : "off");
    }).catch(function () {});
  }

  /* ---------- chat ---------- */
  function chatView() {
    ui.msgs = h("div", { class: "msgs", role: "log", "aria-live": "polite", tabindex: "0" });
    ui.box = h("textarea", { rows: 1, maxlength: 2000, placeholder: "Message the team", "aria-label": "Message" });
    ui.replyBar = h("div", { class: "pending", hidden: true });
    ui.fileBar = h("div", { class: "pending", hidden: true });
    ui.suggest = h("div", { class: "suggest", role: "listbox", "aria-label": "Mention someone", hidden: true });
    ui.send = h("button", { class: "btn primary", type: "submit" }, "Send");
    ui.searchBox = h("input", { type: "search", placeholder: "Search messages", "aria-label": "Search messages", oninput: function () {
      state.search = ui.searchBox.value.trim(); paintChat();
    } });
    ui.searchRow = h("div", { class: "search-row", hidden: true }, ui.searchBox);
    ui.pinBtn = h("button", { class: "chip mono", type: "button", "aria-pressed": "false", onclick: function () {
      state.pinnedOnly = !state.pinnedOnly; paintChat();
    } }, "Pinned");
    var picker = h("input", { type: "file", hidden: true, onchange: function () {
      var f = picker.files[0];
      picker.value = "";
      if (!f) return;
      if (f.size > MAX_FILE) { toast("Files can be up to 10 MB."); return; }
      state.file = f; paintPending(); ui.box.focus();
    } });
    var box = ui.box;
    function grow() { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, 140) + "px"; }
    box.addEventListener("input", function () { grow(); paintSuggest(); });
    // paste a screenshot or drop a file straight into the chat
    function attach(f) {
      if (!f || state.editing) return;
      if (f.size > MAX_FILE) { toast("Files can be up to 10 MB."); return; }
      state.file = f; paintPending(); box.focus();
    }
    box.addEventListener("paste", function (e) {
      var f = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
      if (f) { e.preventDefault(); attach(f); }
    });
    ui.msgs.addEventListener("dragover", function (e) { e.preventDefault(); ui.msgs.classList.add("drop"); });
    ui.msgs.addEventListener("dragleave", function () { ui.msgs.classList.remove("drop"); });
    ui.msgs.addEventListener("drop", function (e) {
      e.preventDefault(); ui.msgs.classList.remove("drop");
      attach(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    });
    box.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !ui.suggest.hidden) { ui.suggest.hidden = true; return; }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        var first = ui.suggest.hidden ? null : ui.suggest.querySelector("button");
        if (first) first.click(); else send();
      }
    });
    ui.grow = grow;
    return h("section", { class: "view chat", "aria-label": "Chat", hidden: true },
      h("header", { class: "view-h" }, h("h1", null, "Chat"),
        h("div", { class: "tools" }, ui.pinBtn,
          iconBtn("search", "Search messages", function () {
            ui.searchRow.hidden = !ui.searchRow.hidden;
            if (ui.searchRow.hidden) { ui.searchBox.value = ""; state.search = ""; paintChat(); } else ui.searchBox.focus();
          }))),
      ui.searchRow,
      ui.msgs,
      h("div", { class: "composer-wrap" },
        ui.suggest, ui.replyBar, ui.fileBar,
        h("form", { class: "composer", onsubmit: function (e) { e.preventDefault(); send(); box.focus(); } },
          iconBtn("clip", "Attach a photo or file", function () { picker.click(); }), picker,
          iconBtn("poll", "Start a poll", openPoll),
          box, ui.send)));
  }

  function afterSend(saved) {
    ui.box.value = ""; ui.grow();
    state.file = null; state.replyTo = null; state.editing = null; paintPending();
    if (saved && saved.id) store.notify(saved.id);
    refresh("messages");
  }
  function send() {
    var body = ui.box.value.trim(), file = state.file, reply = state.replyTo, editing = state.editing;
    if (editing) {
      if (!body) { toast("A message cannot be empty. Delete it instead."); return; }
      store.update("messages", editing.id, { body: body }).then(function () { afterSend(); }).catch(fail);
      return;
    }
    if (!body && !file) return;
    ui.send.disabled = true;
    if (file) ui.send.textContent = "Sending…";
    var up = file ? store.upload(state.user.id, file) : Promise.resolve(null);
    up.then(function (path) {
      var row = { user_id: state.user.id, body: body, reply_to: reply ? reply.id : null };
      if (path) { row.file_path = path; row.file_name = file.name.slice(0, 200); row.file_type = (file.type || "application/octet-stream").slice(0, 120); row.file_size = file.size; }
      return store.add("messages", row);
    }).then(afterSend).catch(fail).then(function () { ui.send.disabled = false; ui.send.textContent = "Send"; });
  }

  function openPoll() {
    if (!upgraded()) { toast("Polls need the latest database update."); return; }
    var q = h("input", { type: "text", id: "pq", maxlength: 140, placeholder: "e.g. Thursday or Friday?" });
    var opts = [0, 1, 2, 3].map(function (i) {
      return h("input", { type: "text", maxlength: 60, "aria-label": "Option " + (i + 1), placeholder: "Option " + (i + 1) + (i > 1 ? " (optional)" : "") });
    });
    sheet("Start a poll", [h("label", { for: "pq" }, "Question"), q, h("label", null, "Options"), h("div", { class: "stack" }, opts)], function () {
      var list = opts.map(function (o) { return o.value.trim(); }).filter(Boolean);
      if (!q.value.trim()) return "Ask a question.";
      if (list.length < 2) return "Add at least two options.";
      return store.add("messages", { user_id: state.user.id, body: "", poll: { q: q.value.trim(), options: list } }).then(function (saved) {
        if (saved && saved.id) store.notify(saved.id);
        refresh("messages");
      });
    }, "Post poll");
  }
  function pollCard(m) {
    var me = state.user.id, votes = state.poll_votes.filter(function (v) { return v.message_id === m.id; });
    var mine = votes.filter(function (v) { return v.user_id === me; })[0];
    return h("div", { class: "poll" },
      h("p", { class: "poll-q" }, m.poll.q),
      m.poll.options.map(function (label, i) {
        var who = votes.filter(function (v) { return v.choice === i; }), on = mine && mine.choice === i;
        var bar = h("i");
        bar.style.width = (votes.length ? Math.round(who.length / votes.length * 100) : 0) + "%";
        return h("button", { type: "button", class: "poll-opt" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false",
          title: who.map(function (v) { return nameOf(v.user_id); }).join(", ") || null,
          onclick: function (e) {
            e.stopPropagation();
            (on ? store.removeWhere("poll_votes", { message_id: m.id, user_id: me })
                : store.upsert("poll_votes", { message_id: m.id, user_id: me, choice: i }, "message_id,user_id"))
              .then(function () { refresh("poll_votes"); }).catch(fail);
          } }, bar, h("span", null, label), h("b", null, who.length));
      }),
      h("p", { class: "mono dim poll-n" }, votes.length + (votes.length === 1 ? " vote" : " votes")));
  }

  function paintPending() {
    var r = state.replyTo, f = state.file, ed = state.editing;
    clear(ui.replyBar).hidden = !(r || ed);
    if (ed) ui.replyBar.append(
      h("div", null, h("p", { class: "mono" }, "Editing your message"), h("p", { class: "clip" }, snippet(ed))),
      h("button", { class: "x", type: "button", "aria-label": "Cancel editing", onclick: function () {
        state.editing = null; ui.box.value = ""; ui.grow(); paintPending();
      } }, "×"));
    else if (r) ui.replyBar.append(
      h("div", null, h("p", { class: "mono" }, "Replying to " + nameOf(r.user_id)), h("p", { class: "clip" }, snippet(r))),
      h("button", { class: "x", type: "button", "aria-label": "Cancel reply", onclick: function () { state.replyTo = null; paintPending(); } }, "×"));
    clear(ui.fileBar).hidden = !f;
    if (f) ui.fileBar.append(
      h("div", null, h("p", { class: "mono" }, "Attached"), h("p", { class: "clip" }, f.name + " · " + fmtSize(f.size))),
      h("button", { class: "x", type: "button", "aria-label": "Remove attachment", onclick: function () { state.file = null; paintPending(); } }, "×"));
    ui.send.textContent = ed ? "Save" : "Send";
  }

  function paintSuggest() {
    var box = ui.box, before = box.value.slice(0, box.selectionStart);
    var m = before.match(/(^|\s)@([^\s@]*)$/);
    clear(ui.suggest);
    if (!m) { ui.suggest.hidden = true; return; }
    var q = m[2].toLowerCase();
    var hits = state.profiles.filter(function (p) { return p.name.toLowerCase().indexOf(q) === 0; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); }).slice(0, 5);
    ui.suggest.hidden = !hits.length;
    hits.forEach(function (p) {
      ui.suggest.append(h("button", { type: "button", role: "option", onmousedown: function (e) { e.preventDefault(); }, onclick: function () {
        var start = before.length - m[2].length - 1;
        box.value = box.value.slice(0, start) + "@" + p.name + " " + box.value.slice(box.selectionStart);
        var caret = start + p.name.length + 2;
        box.setSelectionRange(caret, caret);
        ui.suggest.hidden = true; ui.grow(); box.focus();
      } }, "@" + p.name));
    });
  }

  function snippet(m) {
    var t = (m.body || "").replace(/\s+/g, " ").trim();
    if (!t && m.poll) t = "📊 " + m.poll.q;
    if (!t && m.file_name) t = "📎 " + m.file_name;
    return t.length > 90 ? t.slice(0, 90) + "…" : t;
  }
  function mentionRe() {
    var names = state.profiles.map(function (p) { return p.name; }).filter(Boolean)
      .sort(function (a, b) { return b.length - a.length; }).map(escRe);
    var mention = names.length ? "|@(" + names.join("|") + ")(?![\\w])" : "";
    return new RegExp("(https?:\\/\\/[^\\s<]+[^\\s<.,;:!?)\\]])" + mention, "gi");
  }
  function richText(text, re, myName) {
    var out = [], last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      if (m[1]) out.push(h("a", { href: m[1], target: "_blank", rel: "noopener noreferrer" }, m[1]));
      else out.push(h("span", { class: "at" + (m[2].toLowerCase() === myName ? " me" : "") }, m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  function mentionsMe(m, re, myName) {
    var hit = false, x;
    re.lastIndex = 0;
    while ((x = re.exec(m.body || ""))) if (x[2] && x[2].toLowerCase() === myName) { hit = true; break; }
    return hit;
  }

  function attachment(m) {
    var url = state.urls[m.file_path];
    if (INLINE_IMAGES.test(m.file_type || "")) {
      if (!url) return h("div", { class: "file-img wait" }, m.file_name);
      var img = h("img", { src: url, alt: m.file_name || "Photo", loading: "lazy" });
      img.addEventListener("load", function () { if (ui.stick) scrollChat(); });
      return h("div", { class: "file-img" }, img);
    }
    return h("div", { class: "file-card" },
      icon("file"), h("span", null, h("b", null, m.file_name || "File"), h("i", { class: "mono" }, m.file_size ? fmtSize(m.file_size) : "")));
  }

  function reactionsFor(id) {
    var groups = {};
    state.reactions.forEach(function (r) {
      if (r.message_id !== id) return;
      (groups[r.emoji] = groups[r.emoji] || []).push(r.user_id);
    });
    return groups;
  }
  function toggleReaction(m, emoji) {
    var mine = state.reactions.some(function (r) { return r.message_id === m.id && r.user_id === state.user.id && r.emoji === emoji; });
    (mine ? store.unreact(m.id, state.user.id, emoji) : store.react(m.id, state.user.id, emoji))
      .then(function () { refresh("reactions"); }).catch(fail);
  }
  // who has read up to which message: each teammate's marker sits on the last message they have seen
  function seenMap() {
    var map = {}, ids = state.messages.map(function (m) { return m.id; });
    state.reads.forEach(function (r) {
      if (r.user_id === state.user.id) return;
      var at = 0;
      for (var i = ids.length - 1; i >= 0; i--) if (ids[i] <= r.last_read) { at = ids[i]; break; }
      if (at) (map[at] = map[at] || []).push(nameOf(r.user_id));
    });
    return map;
  }
  function jumpTo(id) {
    state.search = ""; state.pinnedOnly = false; state.openMsg = null;
    ui.searchBox.value = ""; ui.searchRow.hidden = true;
    paintChat();
    var target = document.getElementById("m-" + id);
    if (target) { target.scrollIntoView({ block: "center" }); target.classList.add("flash"); setTimeout(function () { target.classList.remove("flash"); }, 1400); }
  }

  function paintChat() {
    if (!ui.msgs) return;
    var el = ui.msgs, me = state.user.id;
    var nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    ui.stick = nearBottom;
    var re = mentionRe(), myName = nameOf(me).toLowerCase(), seen = seenMap();
    var q = state.search.toLowerCase(), filtering = !!q || state.pinnedOnly;
    var pinned = state.messages.filter(function (m) { return m.pinned; }).length;
    ui.pinBtn.textContent = "Pinned" + (pinned ? " " + pinned : "");
    ui.pinBtn.setAttribute("aria-pressed", state.pinnedOnly ? "true" : "false");
    ui.pinBtn.hidden = !upgraded();
    var list = !filtering ? state.messages : state.messages.filter(function (m) {
      if (state.pinnedOnly && !m.pinned) return false;
      return !q || [m.body, m.file_name, m.poll && m.poll.q, nameOf(m.user_id)].join(" ").toLowerCase().indexOf(q) >= 0;
    });
    clear(el);
    if (filtering) el.append(h("p", { class: "daysep mono" }, list.length + (list.length === 1 ? " message" : " messages") + " · tap one to jump to it"));
    if (!list.length) el.append(h("p", { class: "empty" }, filtering ? (state.pinnedOnly && !q ? "Nothing pinned yet. Tap a message and choose Pin." : "No messages match.") : "No messages yet. Say hello."));
    var lastDay = "", prev = null;
    list.forEach(function (m) {
      var d = new Date(m.created_at), day = ymd(d), mine = m.user_id === me;
      if (day !== lastDay) { el.append(h("p", { class: "daysep mono" }, day === today() ? "Today" : fmtDay(day))); lastDay = day; prev = null; }
      var joined = !filtering && prev && !m.reply_to && prev.user_id === m.user_id && d - new Date(prev.created_at) < 5 * 60 * 1000;
      var open = state.openMsg === m.id;
      var quoted = m.reply_to ? byId(state.messages, m.reply_to) : null;
      var bubble = h("div", { class: "bubble" },
        m.reply_to && h("button", { class: "quote", type: "button", onclick: function (e) { e.stopPropagation(); jumpTo(m.reply_to); } },
          quoted ? [h("b", null, nameOf(quoted.user_id)), " ", snippet(quoted)] : "Original message was deleted"),
        m.file_path && attachment(m),
        m.poll && pollCard(m),
        m.body && h("div", { class: "text" }, richText(m.body, re, myName), m.edited_at && h("i", { class: "edited mono" }, "edited")));
      var toggle = function (e) {
        if (e.target.closest("a, .quote, .poll-opt")) return;
        if (filtering) { jumpTo(m.id); return; }
        state.openMsg = open ? null : m.id; paintChat();
      };
      bubble.addEventListener("click", toggle);
      var more = h("button", { class: "msg-more", type: "button", "aria-expanded": open ? "true" : "false",
        "aria-label": filtering ? "Jump to this message" : "Reactions, reply and more for this message", onclick: toggle }, icon("more"));

      var groups = reactionsFor(m.id), emojis = Object.keys(groups);
      var row = h("div", { id: "m-" + m.id, class: "msg" + (mine ? " mine" : "") + (joined ? " joined" : "") + (open ? " open" : "") + (!mine && mentionsMe(m, re, myName) ? " mention" : "") },
        !joined && h("p", { class: "msg-h mono" }, !mine && avatar(m.user_id, "xs"), mine ? "You" : nameOf(m.user_id), " · ", fmtTime(d), m.pinned && h("span", { class: "pinned" }, " · 📌 pinned")),
        h("div", { class: "msg-row" }, bubble, more),
        emojis.length ? h("div", { class: "reacts" }, emojis.map(function (em) {
          var who = groups[em], minePick = who.indexOf(me) >= 0;
          return h("button", { type: "button", class: "react" + (minePick ? " on" : ""), "aria-pressed": minePick ? "true" : "false",
            title: who.map(nameOf).join(", "), "aria-label": em + " " + who.length + ", " + who.map(nameOf).join(", "),
            onclick: function () { toggleReaction(m, em); } }, em, h("span", null, who.length));
        })) : null,
        open && h("div", { class: "actions" },
          EMOJI.map(function (em) { return h("button", { type: "button", class: "pick", "aria-label": "React " + em, onclick: function () { state.openMsg = null; toggleReaction(m, em); } }, em); }),
          m.file_path && state.urls[m.file_path] && h("a", { class: "act mono", href: state.urls[m.file_path], target: "_blank", rel: "noopener noreferrer" },
            INLINE_IMAGES.test(m.file_type || "") ? "Open photo" : "Open file"),
          h("button", { type: "button", class: "act mono", onclick: function () {
            state.replyTo = m; state.editing = null; state.openMsg = null; paintPending(); paintChat(); ui.box.focus();
          } }, "Reply"),
          upgraded() && h("button", { type: "button", class: "act mono", onclick: function () {
            store.update("messages", m.id, { pinned: !m.pinned, pinned_by: m.pinned ? null : me })
              .then(function () { state.openMsg = null; refresh("messages"); }).catch(fail);
          } }, m.pinned ? "Unpin" : "Pin"),
          upgraded() && mine && m.body && !m.poll && h("button", { type: "button", class: "act mono", onclick: function () {
            state.editing = m; state.replyTo = null; state.openMsg = null;
            ui.box.value = m.body; ui.grow(); paintPending(); paintChat(); ui.box.focus();
          } }, "Edit"),
          mine && h("button", { type: "button", class: "act mono danger", onclick: function () {
            var path = m.file_path;
            store.remove("messages", m.id).then(function () {
              removeStored(path);
              state.openMsg = null; refresh("messages");
            }).catch(fail);
          } }, "Delete")),
        seen[m.id] && !filtering && h("p", { class: "seen mono" }, "Seen by " + seen[m.id].join(", ")));
      el.append(row);
      prev = m;
    });
    fetchUrls();
    if (state.tab === "chat" && !document.hidden) markSeen();
    else markUnread();
    if (nearBottom && !filtering) scrollChat();
  }
  function scrollChat() { if (ui.msgs) ui.msgs.scrollTop = ui.msgs.scrollHeight; }
  function lastMsgId() { return state.messages.length ? state.messages[state.messages.length - 1].id : 0; }
  function markSeen() {
    var last = lastMsgId(), me = state.user.id;
    setSeen(last); markUnread();
    // tell the team how far this person has read
    if (!upgraded() || !last) return;
    var mine = state.reads.filter(function (r) { return r.user_id === me; })[0];
    if (mine && mine.last_read >= last) return;
    if (mine) mine.last_read = last; else state.reads.push({ user_id: me, last_read: last });
    store.upsert("reads", { user_id: me, last_read: last, updated_at: new Date().toISOString() }, "user_id").catch(function () {});
  }
  function markUnread() {
    var seen = getSeen(), me = state.user && state.user.id;
    var n = state.messages.filter(function (m) { return m.id > seen && m.user_id !== me; }).length;
    if (ui.unread) { ui.unread.hidden = !n; ui.unread.setAttribute("aria-label", n + " new messages"); }
    document.title = n ? "(" + n + ") " + TITLE : TITLE;
    try { if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(function () {}); } catch (e) {}
  }

  /* ---------- calendar export ---------- */
  function icsText(s) { return String(s).replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/([,;])/g, "\\$1"); }
  function icsFold(line) {
    var out = [];
    while (line.length > 73) { out.push(line.slice(0, 73)); line = " " + line.slice(73); }
    out.push(line);
    return out.join("\r\n");
  }
  function icsDate(s) { return s.replace(/-/g, ""); }
  function icsLocal(d) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "T" + pad(d.getHours()) + pad(d.getMinutes()) + "00"; }
  function icsStamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, ""); }
  function icsEvent(uid, day, at, summary, desc, rrule) {
    var lines = ["BEGIN:VEVENT", "UID:" + uid + "@orbitus", "DTSTAMP:" + icsStamp()];
    if (at) {
      var p = at.split(":"), start = fromYmd(day);
      start.setHours(+p[0], +p[1]);
      lines.push("DTSTART:" + icsLocal(start), "DTEND:" + icsLocal(new Date(start.getTime() + 3600000)));
    } else {
      var next = fromYmd(day); next.setDate(next.getDate() + 1);
      lines.push("DTSTART;VALUE=DATE:" + icsDate(day), "DTEND;VALUE=DATE:" + icsDate(ymd(next)));
    }
    if (rrule) lines.push(rrule);
    lines.push("SUMMARY:" + icsText(summary));
    if (desc) lines.push("DESCRIPTION:" + icsText(desc));
    lines.push("END:VEVENT");
    return lines;
  }
  function downloadIcs(name, vevents) {
    var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Team NITRO//Orbitus//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Orbitus"]
      .concat.apply([], vevents).concat(["END:VCALENDAR"]);
    var blob = new Blob([lines.map(icsFold).join("\r\n") + "\r\n"], { type: "text/calendar;charset=utf-8" });
    var a = h("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  function eventIcs(ev) {
    var rule = null;
    if (ev.repeat) {
      rule = "RRULE:FREQ=" + (ev.repeat === "monthly" ? "MONTHLY" : "WEEKLY") + (ev.repeat === "fortnightly" ? ";INTERVAL=2" : "");
      if (ev.repeat_until) rule += ";UNTIL=" + icsDate(ev.repeat_until) + (ev.at ? "T235959" : "");
    }
    return icsEvent("event-" + ev.id, ev.day, ev.at && ev.at.slice(0, 5), ev.title, ev.note, rule);
  }
  function missionIcs(m) { return icsEvent("mission-" + m.id, m.due, null, "Due: " + m.title, m.category ? m.category + " mission" : "Mission"); }
  function exportAll() {
    var all = state.events.map(eventIcs).concat(state.missions.filter(function (m) { return m.due && !m.done; }).map(missionIcs));
    if (!all.length) { toast("Nothing to export yet."); return; }
    downloadIcs("orbitus.ics", all);
    toast("Downloaded. Open the file to add it to your calendar.");
  }

  /* ---------- calendar ---------- */
  function repeatSelect(id, value) {
    var s = h("select", { id: id, "aria-label": "Repeats" }, h("option", { value: "" }, "Does not repeat"),
      Object.keys(REPEATS).map(function (k) { return h("option", { value: k }, REPEATS[k]); }));
    s.value = value || "";
    return s;
  }
  // does this event (or one of its repeats) fall on this day?
  function occurs(ev, day) {
    if (day < ev.day) return false;
    if (!ev.repeat) return day === ev.day;
    if (ev.repeat_until && day > ev.repeat_until) return false;
    var a = fromYmd(ev.day), b = fromYmd(day);
    if (ev.repeat === "monthly") return a.getDate() === b.getDate();
    return Math.round((b - a) / 86400000) % (ev.repeat === "weekly" ? 7 : 14) === 0;
  }
  function atSort(a, b) { return (a.at || "").localeCompare(b.at || "") || a.id - b.id; }
  function eventsOn(day) { return state.events.filter(function (e) { return occurs(e, day); }).sort(atSort); }
  function upcoming(from, days, max) {
    var out = [], d = fromYmd(from);
    for (var i = 0; i < days && out.length < max; i++) {
      var key = ymd(d);
      eventsOn(key).forEach(function (ev) { if (out.length < max) out.push({ ev: ev, day: key }); });
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  function calendarView() {
    ui.calTitle = h("h2", { class: "cal-title", "aria-live": "polite" });
    ui.calGrid = h("div", { class: "cal-grid" });
    ui.dayTitle = h("h2");
    ui.dayList = h("ul", { class: "ev-list" });
    ui.dayMissions = h("ul", { class: "m-list compact" });
    ui.dayMissionsH = h("h3", { class: "mono" }, "Missions due");
    ui.upcoming = h("ul", { class: "ev-list" });
    var title = h("input", { type: "text", maxlength: 120, required: true, placeholder: "What is happening?", "aria-label": "Event title" });
    var time = h("input", { type: "time", "aria-label": "Time (optional)" });
    var note = h("input", { type: "text", maxlength: 500, placeholder: "Note (optional)", "aria-label": "Note" });
    var repeat = repeatSelect("newRepeat", "");
    function shift(n) { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + n, 1); paintCalendar(); }
    return h("section", { class: "view calendar", "aria-label": "Calendar", hidden: true },
      h("header", { class: "view-h" }, h("h1", null, "Calendar"),
        h("button", { class: "btn sm", type: "button", onclick: exportAll }, icon("download"), "Export")),
      h("div", { class: "cal-wrap" },
        h("div", { class: "cal" },
          h("div", { class: "cal-bar" },
            ui.calTitle,
            h("button", { class: "btn sm", type: "button", "aria-label": "Previous month", onclick: function () { shift(-1); } }, "←"),
            h("button", { class: "btn sm", type: "button", onclick: function () {
              state.month = startOfMonth(new Date()); state.day = today(); paintCalendar();
            } }, "Today"),
            h("button", { class: "btn sm", type: "button", "aria-label": "Next month", onclick: function () { shift(1); } }, "→")),
          h("div", { class: "cal-dow mono", "aria-hidden": "true" }, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(function (d) { return h("span", null, d); })),
          ui.calGrid,
          h("p", { class: "legend mono" }, h("i", { class: "k-ev" }), "Events", h("i", { class: "k-m" }), "Missions due")),
        h("div", { class: "day" },
          ui.dayTitle, ui.dayList,
          ui.dayMissionsH, ui.dayMissions,
          h("form", { class: "ev-form", onsubmit: function (e) {
            e.preventDefault();
            var t = title.value.trim();
            if (!t) { title.focus(); return; }
            var row = { user_id: state.user.id, title: t, day: state.day, at: time.value || null, note: note.value.trim() || null };
            if (repeat.value) row.repeat = repeat.value;
            store.add("events", row)
              .then(function () { title.value = ""; time.value = ""; note.value = ""; repeat.value = ""; refresh("events"); }).catch(fail);
          } }, title, h("div", { class: "row" }, time, note), upgraded() && repeat, h("button", { class: "btn primary", type: "submit" }, "Add to this day")),
          h("h3", { class: "mono" }, "Coming up"), ui.upcoming)));
  }
  function evItem(ev, withDay, day) {
    var when = withDay ? fmtDay(day || ev.day) + (ev.at ? " · " : "") : "";
    return h("li", null,
      h("span", { class: "ev-when mono" }, when, ev.at ? ev.at.slice(0, 5) : (withDay ? "" : "All day")),
      h("div", null, h("strong", null, ev.title), ev.note && h("p", null, ev.note),
        h("p", { class: "mono dim" }, ev.repeat && h("span", { class: "tag" }, "↻ " + REPEATS[ev.repeat] + " · "), "Added by " + nameOf(ev.user_id))),
      h("div", { class: "tools" },
        iconBtn("edit", "Edit " + ev.title, function () { editEvent(ev); }),
        iconBtn("download", "Add " + ev.title + " to my calendar", function () { downloadIcs("orbitus-event.ics", [eventIcs(ev)]); }),
        h("button", { class: "x", type: "button", "aria-label": "Delete " + ev.title + (ev.repeat ? " and all its repeats" : ""), onclick: function () {
          store.remove("events", ev.id).then(function () { refresh("events"); if (ev.repeat) toast("Removed every repeat of that event."); }).catch(fail);
        } }, "×")));
  }
  function dueItem(m) {
    return h("li", { class: "due-item" },
      h("span", { class: "ev-when mono" }, fmtDay(m.due)),
      h("div", null, h("strong", null, "Due: " + m.title), h("p", { class: "mono dim" }, [m.category || "General", m.owner ? nameOf(m.owner) : "Anyone"].join(" · "))),
      h("div", { class: "tools" }, iconBtn("edit", "Edit " + m.title, function () { editMission(m); })));
  }
  function paintCalendar() {
    if (!ui.calGrid) return;
    var y = state.month.getFullYear(), m = state.month.getMonth(), t = today();
    ui.calTitle.textContent = state.month.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    var dues = {};
    state.missions.forEach(function (x) { if (x.due && !x.done) dues[x.due] = (dues[x.due] || 0) + 1; });
    clear(ui.calGrid);
    var offset = (new Date(y, m, 1).getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
    for (var i = 0; i < offset; i++) ui.calGrid.append(h("span", { class: "cell blank" }));
    for (var d = 1; d <= days; d++) (function (d) {
      var key = y + "-" + pad(m + 1) + "-" + pad(d), n = eventsOn(key).length, k = dues[key] || 0;
      var label = fmtDay(key, true) + (n ? ", " + n + (n === 1 ? " event" : " events") : "") + (k ? ", " + k + (k === 1 ? " mission due" : " missions due") : "");
      ui.calGrid.append(h("button", {
        class: "cell" + (key === t ? " today" : "") + (key === state.day ? " sel" : ""), type: "button",
        "aria-pressed": key === state.day ? "true" : "false", "aria-label": label,
        onclick: function () { state.day = key; paintCalendar(); }
      }, h("span", null, d), (n || k) ? h("i", { class: "dots" },
        n ? h("b", { class: "k-ev" }, n > 3 ? n : new Array(n + 1).join("•")) : null,
        k ? h("b", { class: "k-m" }, k > 3 ? k : new Array(k + 1).join("•")) : null) : null));
    })(d);

    ui.dayTitle.textContent = fmtDay(state.day, true);
    clear(ui.dayList);
    var todays = eventsOn(state.day);
    var dueToday = state.missions.filter(function (x) { return x.due === state.day; }).sort(missionSort);
    if (!todays.length) ui.dayList.append(h("li", { class: "empty" }, dueToday.length ? "No events." : "Nothing planned."));
    todays.forEach(function (e) { ui.dayList.append(evItem(e, false)); });
    clear(ui.dayMissions);
    ui.dayMissionsH.hidden = ui.dayMissions.hidden = !dueToday.length;
    dueToday.forEach(function (x) { ui.dayMissions.append(missionItem(x)); });

    clear(ui.upcoming);
    var next = upcoming(t, 120, 6).map(function (x) { return { day: x.day, at: x.ev.at || "", node: function () { return evItem(x.ev, true, x.day); } }; })
      .concat(state.missions.filter(function (x) { return x.due && x.due >= t && !x.done; }).map(function (x) { return { day: x.due, at: "", node: function () { return dueItem(x); } }; }))
      .sort(function (a, b) { return (a.day + a.at).localeCompare(b.day + b.at); }).slice(0, 6);
    if (!next.length) ui.upcoming.append(h("li", { class: "empty" }, "Nothing coming up."));
    next.forEach(function (x) { ui.upcoming.append(x.node()); });
  }

  /* ---------- missions ---------- */
  function missionsView() {
    ui.progText = h("p", { class: "mono" });
    ui.progBar = h("i");
    ui.mList = h("ul", { class: "m-list" });
    ui.ownerSlot = h("div", { class: "slot" });
    ui.filters = {};
    ui.cats = {};
    var title = h("input", { type: "text", maxlength: 200, required: true, placeholder: "Add a mission", "aria-label": "Mission" });
    var cat = categorySelect("newCat", "");
    var due = h("input", { type: "date", "aria-label": "Due date (optional)", title: "Due date (optional)" });
    return h("section", { class: "view missions", "aria-label": "Missions", hidden: true },
      h("header", { class: "view-h" }, h("h1", null, "Missions"), ui.progText),
      h("div", { class: "prog", "aria-hidden": "true" }, ui.progBar),
      h("form", { class: "m-form", onsubmit: function (e) {
        e.preventDefault();
        var t = title.value.trim();
        if (!t) { title.focus(); return; }
        var owner = ui.ownerSlot.querySelector("select");
        store.add("missions", { user_id: state.user.id, title: t, owner: owner.value || null, category: cat.value || null, due: due.value || null })
          .then(function () { title.value = ""; due.value = ""; refresh("missions"); }).catch(fail);
      } }, title, cat, ui.ownerSlot, due, h("button", { class: "btn primary", type: "submit" }, "Add")),
      h("div", { class: "chips", role: "group", "aria-label": "Show" }, [["open", "To do"], ["mine", "Mine"], ["done", "Done"], ["all", "All"]].map(function (f) {
        return (ui.filters[f[0]] = h("button", { type: "button", class: "chip mono", onclick: function () { state.filter = f[0]; paintMissions(); } }, f[1]));
      })),
      h("div", { class: "chips scroll", role: "group", "aria-label": "Category" }, [["all", "All areas"]].concat(CATEGORIES.map(function (c) { return [c, c]; }), [["general", "General"]]).map(function (f) {
        return (ui.cats[f[0]] = h("button", { type: "button", class: "chip mono", onclick: function () { state.cat = f[0]; paintMissions(); } }, f[1]));
      })),
      ui.mList);
  }
  function paintOwners() {
    if (!ui.ownerSlot) return;
    var old = ui.ownerSlot.querySelector("select");
    clear(ui.ownerSlot).append(ownerSelect("newOwner", old ? old.value : ""));
  }
  function missionSort(a, b) {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done) return new Date(b.done_at) - new Date(a.done_at);
    if ((a.due || "") !== (b.due || "")) return !a.due ? 1 : !b.due ? -1 : a.due.localeCompare(b.due);
    return a.id - b.id;
  }
  function dueLabel(m) {
    if (!m.due) return null;
    var today = ymd(new Date());
    if (m.done) return h("span", null, "Due " + fmtDay(m.due));
    if (m.due < today) return h("span", { class: "late" }, "Overdue · " + fmtDay(m.due));
    if (m.due === today) return h("span", { class: "soon" }, "Due today");
    return h("span", null, "Due " + fmtDay(m.due));
  }
  function missionItem(m) {
    var meta = [h("span", { class: "tag" }, m.category || "General"), m.owner ? nameOf(m.owner) : "Anyone", dueLabel(m),
      m.done && m.done_by ? "done by " + nameOf(m.done_by) : "added by " + nameOf(m.user_id)].filter(Boolean);
    var line = [];
    meta.forEach(function (x, i) { if (i) line.push(" · "); line.push(x); });
    return h("li", { class: m.done ? "done" : "" },
      h("button", { class: "tick", type: "button", role: "checkbox", "aria-checked": m.done ? "true" : "false", "aria-label": m.title, onclick: function () {
        var patch = m.done ? { done: false, done_by: null, done_at: null }
                           : { done: true, done_by: state.user.id, done_at: new Date().toISOString() };
        store.update("missions", m.id, patch).then(function () { refresh("missions"); }).catch(fail);
      } }, m.done ? "✓" : ""),
      h("div", null, h("strong", null, m.title), h("p", { class: "mono dim" }, line)),
      h("div", { class: "tools" },
        iconBtn("edit", "Edit " + m.title, function () { editMission(m); }),
        h("button", { class: "x", type: "button", "aria-label": "Delete " + m.title, onclick: function () {
          store.remove("missions", m.id).then(function () { refresh("missions"); }).catch(fail);
        } }, "×")));
  }
  function paintMissions() {
    if (!ui.mList) return;
    var inCat = state.missions.filter(function (m) {
      return state.cat === "all" || (state.cat === "general" ? !m.category : m.category === state.cat);
    });
    var done = inCat.filter(function (m) { return m.done; }).length;
    ui.progText.textContent = inCat.length ? done + " of " + inCat.length + " complete" : "Nothing yet";
    ui.progBar.style.width = (inCat.length ? Math.round(done / inCat.length * 100) : 0) + "%";
    Object.keys(ui.filters).forEach(function (f) { ui.filters[f].setAttribute("aria-pressed", f === state.filter ? "true" : "false"); });
    Object.keys(ui.cats).forEach(function (f) { ui.cats[f].setAttribute("aria-pressed", f === state.cat ? "true" : "false"); });
    var rows = inCat.filter(function (m) {
      if (state.filter === "mine") return !m.done && m.owner === state.user.id;
      return state.filter === "all" || (state.filter === "done") === m.done;
    }).sort(missionSort);
    clear(ui.mList);
    if (!rows.length) ui.mList.append(h("li", { class: "empty" },
      state.filter === "done" ? "Nothing ticked off yet." : state.filter === "mine" ? "Nothing assigned to you here." : state.filter === "open" && inCat.length ? "All clear. Every mission here is done." : "No missions here yet. Add one above."));
    rows.forEach(function (m) { ui.mList.append(missionItem(m)); });
  }

  /* ---------- car log ---------- */
  function carView() {
    ui.carStats = h("div", { class: "stat-row" });
    ui.carChart = h("div", { class: "card chart" });
    ui.carList = h("ul", { class: "rec-list" });
    var day = h("input", { type: "date", "aria-label": "Date of the run", value: today() });
    var time = h("input", { type: "number", step: "0.001", min: "0.001", max: "99", inputmode: "decimal", placeholder: "Track time (s)", "aria-label": "Track time in seconds" });
    var car = h("input", { type: "text", maxlength: 60, placeholder: "Car version, e.g. G-ORB!T v2", "aria-label": "Car version" });
    var parts = h("input", { type: "text", maxlength: 500, placeholder: "Parts on the car (wings, wheels, cartridge…)", "aria-label": "Parts on the car" });
    var note = h("input", { type: "text", maxlength: 500, placeholder: "Note (optional)", "aria-label": "Note" });
    ui.carForm = h("form", { class: "rec-form", onsubmit: function (e) {
      e.preventDefault();
      var t = parseFloat(time.value);
      if (!day.value) { day.focus(); return; }
      if (!(t > 0 && t < 100)) { toast("Enter the track time in seconds, for example 1.234."); time.focus(); return; }
      store.add("runs", { user_id: state.user.id, day: day.value, time_s: t, car: car.value.trim() || null, parts: parts.value.trim() || null, note: note.value.trim() || null })
        .then(function () { time.value = ""; note.value = ""; refresh("runs"); }).catch(fail);
    } }, h("div", { class: "pair" }, day, time), car, parts, note, h("button", { class: "btn primary", type: "submit" }, "Log this run"));
    return h("section", { class: "view car", "aria-label": "Car log", hidden: true },
      h("header", { class: "view-h" }, h("h1", null, "Car log"),
        h("button", { class: "btn sm", type: "button", onclick: function () {
          if (!state.runs.length) { toast("Nothing to export yet."); return; }
          saveText("orbitus-car-log.csv", csv([["Date", "Track time (s)", "Car version", "Parts", "Note", "Logged by"]].concat(
            state.runs.slice().sort(runSort).map(function (r) { return [r.day, (+r.time_s).toFixed(3), r.car, r.parts, r.note, nameOf(r.user_id)]; }))), "text/csv;charset=utf-8");
        } }, icon("download"), "Export")),
      ui.carStats, ui.carChart, (ui.carVersions = h("div", { class: "card versions", hidden: true })), ui.carForm, ui.carList);
  }
  function runSort(a, b) { return a.day.localeCompare(b.day) || a.id - b.id; }
  function editRun(r) {
    var day = h("input", { type: "date", id: "rDay", value: r.day });
    var time = h("input", { type: "number", id: "rTime", step: "0.001", min: "0.001", max: "99", inputmode: "decimal", value: (+r.time_s).toFixed(3) });
    var car = h("input", { type: "text", id: "rCar", maxlength: 60, value: r.car || null });
    var parts = h("input", { type: "text", id: "rParts", maxlength: 500, value: r.parts || null });
    var note = h("input", { type: "text", id: "rNote", maxlength: 500, value: r.note || null });
    sheet("Edit run", [
      h("div", { class: "pair" },
        h("div", null, h("label", { for: "rDay" }, "Date"), day),
        h("div", null, h("label", { for: "rTime" }, "Track time (s)"), time)),
      h("label", { for: "rCar" }, "Car version"), car,
      h("label", { for: "rParts" }, "Parts on the car"), parts,
      h("label", { for: "rNote" }, "Note"), note
    ], function () {
      var t = parseFloat(time.value);
      if (!day.value) return "Pick a date.";
      if (!(t > 0 && t < 100)) return "Enter the track time in seconds, for example 1.234.";
      return store.update("runs", r.id, { day: day.value, time_s: t, car: car.value.trim() || null, parts: parts.value.trim() || null, note: note.value.trim() || null })
        .then(function () { refresh("runs"); });
    });
  }
  function lineChart(runs) {
    var W = window.innerWidth < 700 ? 360 : 720, H = 230, L = 50, R = 14, T = 16, B = 32;
    var times = runs.map(function (r) { return +r.time_s; });
    var lo = Math.min.apply(null, times), hi = Math.max.apply(null, times), span = (hi - lo) || 0.1;
    lo -= span * 0.15; hi += span * 0.15;
    function x(i) { return L + (runs.length === 1 ? 0.5 : i / (runs.length - 1)) * (W - L - R); }
    function y(v) { return T + (hi - v) / (hi - lo) * (H - T - B); }   // faster (lower) times sit lower on the chart
    var best = times.indexOf(Math.min.apply(null, times));
    var root = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Track times over " + runs.length + " runs. Best " + times[best].toFixed(3) + " seconds." });
    [0, 0.5, 1].forEach(function (f) {
      var v = lo + (hi - lo) * f, yy = y(v);
      root.append(svg("line", { x1: L, x2: W - R, y1: yy, y2: yy, class: "grid" }),
        svg("text", { x: L - 8, y: yy + 4, "text-anchor": "end", class: "axis" }, v.toFixed(3)));
    });
    root.append(svg("text", { x: L, y: H - 8, class: "axis" }, fmtDay(runs[0].day)),
      svg("text", { x: W - R, y: H - 8, "text-anchor": "end", class: "axis" }, fmtDay(runs[runs.length - 1].day)));
    if (runs.length > 1) root.append(svg("polyline", { class: "line", points: runs.map(function (r, i) { return x(i).toFixed(1) + "," + y(+r.time_s).toFixed(1); }).join(" ") }));
    runs.forEach(function (r, i) {
      var dot = svg("circle", { cx: x(i).toFixed(1), cy: y(+r.time_s).toFixed(1), r: i === best ? 7 : 4.5, class: i === best ? "dot best" : "dot" });
      dot.append(svg("title", null, fmtDay(r.day) + ": " + (+r.time_s).toFixed(3) + "s" + (r.car ? " · " + r.car : "")));
      root.append(dot);
    });
    return root;
  }
  function paintCar() {
    if (!ui.carList) return;
    var off = !!state.missing.runs;
    ui.carForm.hidden = off;
    clear(ui.carStats); clear(ui.carChart); clear(ui.carList); clear(ui.carVersions);
    ui.carChart.hidden = off; ui.carVersions.hidden = true;
    if (off) { ui.carList.append(h("li", { class: "empty" }, notice())); return; }
    var runs = state.runs.slice().sort(runSort), times = runs.map(function (r) { return +r.time_s; });
    if (runs.length) {
      var best = Math.min.apply(null, times), first = times[0], last = times[times.length - 1], gain = first - best;
      ui.carStats.append(
        h("div", { class: "stat" }, h("b", null, best.toFixed(3) + "s"), h("span", { class: "mono" }, "best run")),
        h("div", { class: "stat" }, h("b", null, last.toFixed(3) + "s"), h("span", { class: "mono" }, "latest run")),
        h("div", { class: "stat" }, h("b", null, (gain > 0 ? "−" : "") + gain.toFixed(3) + "s"), h("span", { class: "mono" }, "gained since first")),
        h("div", { class: "stat" }, h("b", null, runs.length), h("span", { class: "mono" }, runs.length === 1 ? "run logged" : "runs logged")));
      ui.carChart.append(h("h2", null, "Track time by run"), lineChart(runs),
        h("p", { class: "mono dim" }, "Lower is faster · the pink dot is the best run"));
    } else ui.carChart.append(h("h2", null, "Track time by run"), h("p", { class: "dim" }, "Log your first test run below and the chart will start here."));
    // best time for each car version, fastest first
    var byCar = {};
    runs.forEach(function (r) {
      var k = r.car || "Unnamed";
      byCar[k] = byCar[k] || { best: Infinity, n: 0 };
      byCar[k].best = Math.min(byCar[k].best, +r.time_s); byCar[k].n++;
    });
    var cars = Object.keys(byCar).sort(function (a, b) { return byCar[a].best - byCar[b].best; });
    if (cars.length > 1) {
      ui.carVersions.hidden = false;
      var slow = byCar[cars[cars.length - 1]].best, fast = byCar[cars[0]].best;
      ui.carVersions.append(h("h2", null, "Best by car version"), h("ul", { class: "bars" }, cars.map(function (c, i) {
        var bar = h("i");
        bar.style.width = (slow === fast ? 100 : 100 - (byCar[c].best - fast) / (slow - fast) * 55) + "%";
        return h("li", { class: i ? null : "top" }, h("span", null, c, h("em", { class: "mono" }, byCar[c].n + (byCar[c].n === 1 ? " run" : " runs"))),
          h("div", { class: "bar" }, bar), h("b", { class: "mono" }, byCar[c].best.toFixed(3) + "s"));
      })));
    }
    if (!runs.length) ui.carList.append(h("li", { class: "empty" }, "No runs logged yet."));
    runs.slice().reverse().forEach(function (r) {
      ui.carList.append(h("li", null,
        h("span", { class: "rec-n mono" }, (+r.time_s).toFixed(3) + "s"),
        h("div", null, h("strong", null, r.car || "Test run"), r.parts && h("p", null, r.parts), r.note && h("p", null, r.note),
          h("p", { class: "mono dim" }, fmtDay(r.day) + " · logged by " + nameOf(r.user_id))),
        h("div", { class: "tools" },
          iconBtn("edit", "Edit this run", function () { editRun(r); }),
          h("button", { class: "x", type: "button", "aria-label": "Delete this run", onclick: function () {
            store.remove("runs", r.id).then(function () { refresh("runs"); }).catch(fail);
          } }, "×"))));
    });
  }

  /* ---------- budget ---------- */
  function budgetView() {
    ui.budgetStats = h("div", { class: "stat-row" });
    ui.budgetList = h("ul", { class: "rec-list" });
    var kind = h("select", { "aria-label": "Money in or out" }, h("option", { value: "out" }, "Money out"), h("option", { value: "in" }, "Money in"));
    var amount = h("input", { type: "number", step: "0.01", min: "0.01", inputmode: "decimal", placeholder: "Amount (₹)", "aria-label": "Amount in rupees" });
    var label = h("input", { type: "text", maxlength: 120, placeholder: "What was it for?", "aria-label": "What was it for" });
    var day = h("input", { type: "date", "aria-label": "Date", value: today() });
    var cat = h("select", { "aria-label": "Category" }, LEDGER_CATS.map(function (c) { return h("option", { value: c }, c); }));
    cat.value = "Materials";
    kind.addEventListener("change", function () { cat.value = kind.value === "in" ? "Sponsorship" : "Materials"; });
    var receipt = null;
    var pick = h("input", { type: "file", hidden: true, onchange: function () {
      var f = pick.files[0]; pick.value = "";
      if (!f) return;
      if (f.size > MAX_FILE) { toast("Receipts can be up to 10 MB."); return; }
      receipt = f; pickBtn.lastChild.textContent = f.name.length > 22 ? f.name.slice(0, 20) + "…" : f.name;
    } });
    var pickBtn = h("button", { class: "btn", type: "button", onclick: function () { pick.click(); } }, icon("clip"), "Add receipt");
    var add = h("button", { class: "btn primary", type: "submit" }, "Add");
    ui.budgetForm = h("form", { class: "rec-form", onsubmit: function (e) {
      e.preventDefault();
      var a = parseFloat(amount.value);
      if (!(a > 0)) { toast("Enter an amount."); amount.focus(); return; }
      if (!label.value.trim()) { label.focus(); return; }
      add.disabled = true;
      (receipt ? store.upload(state.user.id, receipt) : Promise.resolve(null)).then(function (path) {
        return store.add("ledger", { user_id: state.user.id, day: day.value || today(), kind: kind.value, amount: a, label: label.value.trim(),
          category: cat.value, file_path: path, file_name: path ? receipt.name.slice(0, 200) : null });
      }).then(function () {
        amount.value = ""; label.value = ""; receipt = null; pickBtn.lastChild.textContent = "Add receipt"; refresh("ledger");
      }).catch(fail).then(function () { add.disabled = false; });
    } }, h("div", { class: "pair" }, kind, amount), label, h("div", { class: "pair" }, day, cat), h("div", { class: "pair" }, pickBtn, add), pick);
    return h("section", { class: "view budget", "aria-label": "Budget", hidden: true },
      h("header", { class: "view-h" }, h("h1", null, "Budget"),
        h("button", { class: "btn sm", type: "button", onclick: function () {
          if (!state.ledger.length) { toast("Nothing to export yet."); return; }
          saveText("orbitus-budget.csv", csv([["Date", "In or out", "Amount (INR)", "What", "Category", "Added by", "Receipt"]].concat(
            state.ledger.slice().sort(function (a, b) { return a.day.localeCompare(b.day) || a.id - b.id; }).map(function (r) {
              return [r.day, r.kind === "in" ? "In" : "Out", (+r.amount).toFixed(2), r.label, r.category, nameOf(r.user_id), r.file_name || ""];
            }))), "text/csv;charset=utf-8");
        } }, icon("download"), "Export")),
      ui.budgetStats, (ui.budgetCats = h("div", { class: "card versions", hidden: true })), ui.budgetForm, ui.budgetList);
  }
  function editEntry(r) {
    var kind = h("select", { id: "lKind" }, h("option", { value: "out" }, "Money out"), h("option", { value: "in" }, "Money in"));
    kind.value = r.kind;
    var amount = h("input", { type: "number", id: "lAmount", step: "0.01", min: "0.01", inputmode: "decimal", value: (+r.amount).toFixed(2) });
    var label = h("input", { type: "text", id: "lLabel", maxlength: 120, value: r.label });
    var day = h("input", { type: "date", id: "lDay", value: r.day });
    var cat = h("select", { id: "lCat" }, LEDGER_CATS.map(function (c) { return h("option", { value: c }, c); }));
    cat.value = LEDGER_CATS.indexOf(r.category) >= 0 ? r.category : "Other";
    sheet("Edit entry", [
      h("div", { class: "pair" },
        h("div", null, h("label", { for: "lKind" }, "In or out"), kind),
        h("div", null, h("label", { for: "lAmount" }, "Amount (₹)"), amount)),
      h("label", { for: "lLabel" }, "What was it for?"), label,
      h("div", { class: "pair" },
        h("div", null, h("label", { for: "lDay" }, "Date"), day),
        h("div", null, h("label", { for: "lCat" }, "Category"), cat))
    ], function () {
      var a = parseFloat(amount.value);
      if (!(a > 0)) return "Enter an amount.";
      if (!label.value.trim()) return "Say what it was for.";
      if (!day.value) return "Pick a date.";
      return store.update("ledger", r.id, { kind: kind.value, amount: a, label: label.value.trim(), day: day.value, category: cat.value })
        .then(function () { refresh("ledger"); });
    });
  }
  function paintBudget() {
    if (!ui.budgetList) return;
    var off = !!state.missing.ledger;
    ui.budgetForm.hidden = off;
    clear(ui.budgetStats); clear(ui.budgetList); clear(ui.budgetCats); ui.budgetCats.hidden = true;
    if (off) { ui.budgetList.append(h("li", { class: "empty" }, notice())); return; }
    var inSum = 0, outSum = 0;
    state.ledger.forEach(function (r) { if (r.kind === "in") inSum += +r.amount; else outSum += +r.amount; });
    var left = inSum - outSum;
    ui.budgetStats.append(
      h("div", { class: "stat" }, h("b", { class: "pos" }, money(inSum)), h("span", { class: "mono" }, "money in")),
      h("div", { class: "stat" }, h("b", { class: "neg" }, money(outSum)), h("span", { class: "mono" }, "money out")),
      h("div", { class: "stat" }, h("b", { class: left < 0 ? "neg" : null }, (left < 0 ? "−" : "") + money(Math.abs(left))), h("span", { class: "mono" }, "left to spend")));
    // where the money went
    var spent = {};
    state.ledger.forEach(function (r) { if (r.kind === "out") spent[r.category || "Other"] = (spent[r.category || "Other"] || 0) + +r.amount; });
    var cats = Object.keys(spent).sort(function (a, b) { return spent[b] - spent[a]; });
    if (cats.length) {
      ui.budgetCats.hidden = false;
      ui.budgetCats.append(h("h2", null, "Where the money went"), h("ul", { class: "bars" }, cats.map(function (c) {
        var bar = h("i");
        bar.style.width = Math.max(3, spent[c] / spent[cats[0]] * 100) + "%";
        return h("li", null, h("span", null, c, h("em", { class: "mono" }, Math.round(spent[c] / outSum * 100) + "%")),
          h("div", { class: "bar" }, bar), h("b", { class: "mono" }, money(spent[c])));
      })));
    }
    var rows = state.ledger.slice().sort(function (a, b) { return b.day.localeCompare(a.day) || b.id - a.id; });
    if (!rows.length) ui.budgetList.append(h("li", { class: "empty" }, "Nothing recorded yet. Add sponsor money as “Money in” and each purchase as “Money out”."));
    rows.forEach(function (r) {
      ui.budgetList.append(h("li", null,
        h("span", { class: "rec-n mono " + (r.kind === "in" ? "pos" : "neg") }, (r.kind === "in" ? "+" : "−") + money(r.amount)),
        h("div", null, h("strong", null, r.label),
          h("p", { class: "mono dim" }, h("span", { class: "tag" }, r.category || "Other"), " · " + fmtDay(r.day) + " · " + nameOf(r.user_id))),
        h("div", { class: "tools" },
          r.file_path && fileLink(r.file_path, "Receipt"),
          iconBtn("edit", "Edit " + r.label, function () { editEntry(r); }),
          h("button", { class: "x", type: "button", "aria-label": "Delete " + r.label, onclick: function () {
            store.remove("ledger", r.id).then(function () { removeStored(r.file_path); refresh("ledger"); }).catch(fail);
          } }, "×"))));
    });
    fetchUrls();
  }

  /* ---------- files ---------- */
  function filesView() {
    ui.fileList = h("ul", { class: "rec-list" });
    ui.folders = {};
    var folder = h("select", { "aria-label": "Folder" }, FOLDERS.map(function (f) { return h("option", { value: f }, f); }));
    var btn = h("button", { class: "btn primary", type: "button", onclick: function () { pick.click(); } }, icon("clip"), "Upload a file");
    var pick = h("input", { type: "file", hidden: true, multiple: true, onchange: function () {
      var list = Array.prototype.slice.call(pick.files); pick.value = "";
      var big = list.filter(function (f) { return f.size > MAX_DOC; });
      if (big.length) toast(big[0].name + " is over 25 MB and was skipped.");
      list = list.filter(function (f) { return f.size <= MAX_DOC; });
      if (!list.length) return;
      btn.disabled = true; btn.lastChild.textContent = "Uploading…";
      list.reduce(function (chain, f) {
        return chain.then(function () { return store.upload(state.user.id, f); }).then(function (path) {
          return store.add("files", { user_id: state.user.id, name: f.name.slice(0, 200), folder: folder.value, file_path: path,
            file_type: (f.type || "application/octet-stream").slice(0, 120), file_size: f.size });
        });
      }, Promise.resolve()).then(function () { refresh("files"); }).catch(fail)
        .then(function () { btn.disabled = false; btn.lastChild.textContent = "Upload a file"; });
    } });
    ui.filesForm = h("div", { class: "rec-form" }, h("div", { class: "pair" }, folder, btn), pick);
    return h("section", { class: "view files", "aria-label": "Files", hidden: true },
      h("header", { class: "view-h" }, h("h1", null, "Files"), h("p", { class: "mono dim" }, "Up to 25 MB each")),
      ui.filesForm,
      h("div", { class: "chips scroll", role: "group", "aria-label": "Folder" }, [["all", "All"]].concat(FOLDERS.map(function (f) { return [f, f]; })).map(function (f) {
        return (ui.folders[f[0]] = h("button", { type: "button", class: "chip mono", onclick: function () { state.folder = f[0]; paintFiles(); } }, f[1]));
      })),
      ui.fileList);
  }
  function paintFiles() {
    if (!ui.fileList) return;
    var off = !!state.missing.files;
    ui.filesForm.hidden = off;
    clear(ui.fileList);
    if (off) { ui.fileList.append(h("li", { class: "empty" }, notice())); return; }
    Object.keys(ui.folders).forEach(function (f) { ui.folders[f].setAttribute("aria-pressed", f === state.folder ? "true" : "false"); });
    var rows = state.files.filter(function (f) { return state.folder === "all" || f.folder === state.folder; })
      .sort(function (a, b) { return b.id - a.id; });
    if (!rows.length) ui.fileList.append(h("li", { class: "empty" }, state.files.length ? "Nothing in this folder." : "No files yet. Upload the portfolio, sketches or documents so they are all in one place."));
    rows.forEach(function (f) {
      ui.fileList.append(h("li", null,
        h("span", { class: "rec-ic" }, icon("file")),
        h("div", null, h("strong", null, f.name),
          h("p", { class: "mono dim" }, h("span", { class: "tag" }, f.folder), " · " + (f.file_size ? fmtSize(f.file_size) + " · " : "") + nameOf(f.user_id) + " · " + fmtDay(ymd(new Date(f.created_at))))),
        h("div", { class: "tools" },
          fileLink(f.file_path, "Open"),
          h("button", { class: "x", type: "button", "aria-label": "Delete " + f.name, onclick: function () {
            store.remove("files", f.id).then(function () { removeStored(f.file_path); refresh("files"); }).catch(fail);
          } }, "×"))));
    });
    fetchUrls();
  }

  /* ---------- stores ---------- */
  function supaStore(cfg) {
    var sb = window.supabase.createClient(cfg.url, cfg.anonKey);
    var bucket = function () { return sb.storage.from("chat-files"); };
    function pick(u) { return u ? { id: u.id, email: u.email } : null; }
    function ok(res) { if (res.error) throw res.error; return res.data; }
    var orders = {
      profiles: function (q) { return q.order("name"); },
      messages: function (q) { return q.order("id", { ascending: false }).limit(500); },
      events: function (q) { return q.order("day"); },
      missions: function (q) { return q.order("id"); },
      reactions: function (q) { return q.order("created_at", { ascending: false }).limit(3000); },
      poll_votes: function (q) { return q.limit(3000); },
      runs: function (q) { return q.order("day").limit(2000); },
      ledger: function (q) { return q.order("day", { ascending: false }).limit(2000); },
      files: function (q) { return q.order("id", { ascending: false }).limit(1000); }
    };
    function push(body) {
      return sb.auth.getSession().then(function (r) {
        var token = r.data.session && r.data.session.access_token;
        if (!token) throw new Error("Sign in again.");
        return fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(body) });
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          if (!res.ok) throw new Error(d.error || "Notifications are not available right now.");
          return d;
        });
      });
    }
    return {
      demo: false,
      session: function () { return sb.auth.getSession().then(function (r) { return pick(r.data.session && r.data.session.user); }); },
      signIn: function (email, password) { return sb.auth.signInWithPassword({ email: email, password: password }).then(function (r) { return pick(ok(r).user); }); },
      signOut: function () { return sb.auth.signOut().then(function () {}); },
      onAuth: function (cb) { sb.auth.onAuthStateChange(function (ev) { setTimeout(function () { cb(ev); }, 0); }); },
      resetPassword: function (email, redirectTo) { return sb.auth.resetPasswordForEmail(email, { redirectTo: redirectTo }).then(ok); },
      checkPassword: function (email, p) { return sb.auth.signInWithPassword({ email: email, password: p }).then(ok); },
      setPassword: function (p) { return sb.auth.updateUser({ password: p }).then(ok); },
      isTeam: function () { return sb.rpc("is_team").then(ok); },
      list: function (t) {
        var q = sb.from(t).select("*");
        return (orders[t] ? orders[t](q) : q).then(function (r) { var d = ok(r); return t === "messages" ? d.reverse() : d; });
      },
      // messages hand back their new id so a notification can be sent for them
      add: function (t, row) { return t === "messages" ? sb.from(t).insert(row).select("id").single().then(ok) : sb.from(t).insert(row).then(ok); },
      update: function (t, id, patch) { return sb.from(t).update(patch).eq("id", id).then(ok); },
      remove: function (t, id) { return sb.from(t).delete().eq("id", id).then(ok); },
      upsert: function (t, row, keys) { return sb.from(t).upsert(row, { onConflict: keys }).then(ok); },
      removeWhere: function (t, match) { return sb.from(t).delete().match(match).then(ok); },
      react: function (mid, uid, emoji) { return sb.from("reactions").insert({ message_id: mid, user_id: uid, emoji: emoji }).then(ok); },
      unreact: function (mid, uid, emoji) { return sb.from("reactions").delete().eq("message_id", mid).eq("user_id", uid).eq("emoji", emoji).then(ok); },
      upload: function (uid, file) {
        var safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-80) || "file";
        var path = uid + "/" + Date.now() + "-" + safe;
        return bucket().upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false })
          .then(ok).then(function () { return path; });
      },
      fileUrls: function (paths) {
        return bucket().createSignedUrls(paths, 3600).then(ok).then(function (list) {
          var map = {};
          list.forEach(function (x) { if (x.signedUrl) map[x.path] = x.signedUrl; });
          return map;
        });
      },
      removeFile: function (path) { return bucket().remove([path]).then(ok); },
      saveName: function (id, name) { return sb.from("profiles").upsert({ id: id, name: name, updated_at: new Date().toISOString() }).then(ok); },
      pushKey: function () { return push({ action: "key" }).then(function (d) { return d.publicKey; }); },
      notify: function (id) { push({ action: "notify", message_id: id }).catch(function () {}); },
      watch: function (cb) {
        var ch = sb.channel("orbitus");
        TABLES.forEach(function (t) { ch.on("postgres_changes", { event: "*", schema: "public", table: t }, function () { cb(t); }); });
        ch.subscribe();
        // catch up on anything missed while the tab was in the background
        var wake = function () { if (!document.hidden) TABLES.forEach(cb); };
        document.addEventListener("visibilitychange", wake);
        return function () { sb.removeChannel(ch); document.removeEventListener("visibilitychange", wake); };
      }
    };
  }

  function demoStore() {
    var KEY = "orbitus-demo-3", ME = "me", db;
    function day(n) { var d = new Date(); d.setDate(d.getDate() + n); return ymd(d); }
    function ago(mins) { return new Date(Date.now() - mins * 60000).toISOString(); }
    function seed() {
      return {
        seq: 100, signedIn: false, email: "", blobs: {},
        profiles: [{ id: "a", name: "Aariv" }, { id: "b", name: "Aryeh" }, { id: "c", name: "Rehnuma" }, { id: "d", name: "Vivaan" }, { id: "e", name: "Aarna" }],
        messages: [
          { id: 1, user_id: "b", body: "Front wing print finished overnight. Bringing it in tomorrow.", pinned: true, created_at: ago(1500) },
          { id: 2, user_id: "e", body: "Portfolio pages 4 to 9 are ready for review. @Aariv can you check the sponsor page?", created_at: ago(190) },
          { id: 3, user_id: "d", body: "Can everyone add their free slots to the calendar for track testing?", created_at: ago(42) },
          { id: 4, user_id: "c", body: "Thursday after school works for me.", reply_to: 3, created_at: ago(30) },
          { id: 5, user_id: "d", body: "", poll: { q: "Which day for track testing?", options: ["Thursday", "Friday", "Saturday morning"] }, created_at: ago(20) }
        ],
        reactions: [{ message_id: 1, user_id: "d", emoji: "🔥" }, { message_id: 1, user_id: "e", emoji: "🔥" }, { message_id: 3, user_id: "a", emoji: "👍" }],
        poll_votes: [{ message_id: 5, user_id: "c", choice: 0 }, { message_id: 5, user_id: "b", choice: 0 }, { message_id: 5, user_id: "e", choice: 2 }],
        reads: [{ user_id: "b", last_read: 5 }, { user_id: "c", last_read: 5 }, { user_id: "a", last_read: 3 }],
        events: [
          { id: 6, user_id: "d", title: "Track testing", day: day(2), at: "15:30", note: "Bring both cars and the spare cartridges." },
          { id: 7, user_id: "e", title: "Team meeting", day: day(-13), at: "16:00", note: null, repeat: "weekly" },
          { id: 8, user_id: "a", title: "Sponsor call", day: day(6), at: null, note: "Time to be confirmed." }
        ],
        missions: [
          { id: 9, user_id: "b", title: "Sand and prime the new body", owner: "c", category: "Manufacturing", due: day(1), done: false, done_by: null, done_at: null },
          { id: 10, user_id: "e", title: "Proofread the enterprise portfolio", owner: ME, category: "Portfolio", due: day(4), done: false, done_by: null, done_at: null },
          { id: 11, user_id: "d", title: "Update the pit display sketches", owner: ME, category: "Design", due: day(-1), done: false, done_by: null, done_at: null },
          { id: 12, user_id: "a", title: "Send thank-you notes to sponsors", owner: "a", category: "Enterprise", due: null, done: true, done_by: "a", done_at: ago(600) }
        ],
        runs: [
          { id: 13, user_id: "b", day: day(-30), time_s: 1.412, car: "ORB!TUS", parts: "Nationals setup", note: null },
          { id: 14, user_id: "b", day: day(-21), time_s: 1.385, car: "G-ORB!T v1", parts: "New front wing, old wheels", note: null },
          { id: 15, user_id: "d", day: day(-14), time_s: 1.391, car: "G-ORB!T v1", parts: "Lighter wheels", note: "Wobble off the line." },
          { id: 16, user_id: "c", day: day(-7), time_s: 1.342, car: "G-ORB!T v2", parts: "Lighter wheels, new rear wing", note: null },
          { id: 17, user_id: "b", day: day(-2), time_s: 1.318, car: "G-ORB!T v2", parts: "Polished axles", note: "Best so far." }
        ],
        ledger: [
          { id: 18, user_id: "a", day: day(-25), kind: "in", amount: 40000, label: "Sponsor contribution", category: "Sponsorship" },
          { id: 19, user_id: "c", day: day(-18), kind: "out", amount: 6200, label: "Balsa blocks and wheels", category: "Materials" },
          { id: 20, user_id: "b", day: day(-9), kind: "out", amount: 3500, label: "3D printing", category: "Manufacturing" }
        ],
        files: [],
        settings: [{ key: "competition", value: { name: "Regional Finals", date: day(47) } }],
        push_subscriptions: []
      };
    }
    try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    if (!db || !db.profiles) db = seed();
    function save() {
      try { localStorage.setItem(KEY, JSON.stringify(db)); }
      catch (e) { return Promise.reject(new Error("Demo storage is full. Remove some files.")); }
      return Promise.resolve();
    }
    function done(v) { return save().then(function () { return v; }); }
    function user() { return { id: ME, email: db.email }; }
    function same(row, match) { return Object.keys(match).every(function (k) { return row[k] === match[k]; }); }
    return {
      demo: true,
      session: function () { return Promise.resolve(db.signedIn ? user() : null); },
      signIn: function (email) { db.signedIn = true; db.email = email; return done(user()); },
      signOut: function () { db.signedIn = false; return done(); },
      onAuth: function () {},
      resetPassword: function () { return Promise.resolve(); },
      checkPassword: function () { return Promise.resolve(); },
      setPassword: function () { return Promise.resolve(); },
      isTeam: function () { return Promise.resolve(true); },
      list: function (t) { return Promise.resolve(JSON.parse(JSON.stringify(db[t] || []))); },
      add: function (t, row) {
        row.id = ++db.seq; row.created_at = new Date().toISOString();
        if (t === "missions") { row.done = false; row.done_by = null; row.done_at = null; }
        db[t].push(row); return done({ id: row.id });
      },
      update: function (t, id, patch) {
        db[t].forEach(function (r) {
          if (r.id !== id) return;
          if (t === "messages" && "body" in patch) r.edited_at = new Date().toISOString();
          Object.assign(r, patch);
        });
        return done();
      },
      remove: function (t, id) {
        db[t] = db[t].filter(function (r) { return r.id !== id; });
        if (t === "messages") {
          db.reactions = db.reactions.filter(function (r) { return r.message_id !== id; });
          db.poll_votes = db.poll_votes.filter(function (r) { return r.message_id !== id; });
          db.messages.forEach(function (m) { if (m.reply_to === id) m.reply_to = null; });
        }
        return done();
      },
      upsert: function (t, row, keys) {
        var match = {};
        keys.split(",").forEach(function (k) { match[k] = row[k]; });
        var hit = db[t].filter(function (r) { return same(r, match); })[0];
        if (hit) Object.assign(hit, row); else db[t].push(row);
        return done();
      },
      removeWhere: function (t, match) { db[t] = db[t].filter(function (r) { return !same(r, match); }); return done(); },
      react: function (mid, uid, emoji) { db.reactions.push({ message_id: mid, user_id: uid, emoji: emoji }); return done(); },
      unreact: function (mid, uid, emoji) {
        db.reactions = db.reactions.filter(function (r) { return !(r.message_id === mid && r.user_id === uid && r.emoji === emoji); });
        return done();
      },
      upload: function (uid, file) {
        if (file.size > 1.5 * 1024 * 1024) return Promise.reject(new Error("Demo mode keeps files under 1.5 MB."));
        return new Promise(function (resolve, reject) {
          var r = new FileReader();
          r.onload = function () { var path = uid + "/" + Date.now() + "-" + file.name; db.blobs[path] = r.result; done(path).then(resolve, reject); };
          r.onerror = function () { reject(new Error("Could not read that file.")); };
          r.readAsDataURL(file);
        });
      },
      fileUrls: function (paths) {
        var map = {};
        paths.forEach(function (p) { if (db.blobs[p]) map[p] = db.blobs[p]; });
        return Promise.resolve(map);
      },
      removeFile: function (path) { delete db.blobs[path]; return done(); },
      saveName: function (id, name) {
        var p = db.profiles.filter(function (r) { return r.id === id; })[0];
        if (p) p.name = name; else db.profiles.push({ id: id, name: name });
        return done();
      },
      pushKey: function () { return Promise.reject(new Error("Notifications switch on once Orbitus is connected to the real workspace.")); },
      notify: function () {},
      watch: function () { return function () {}; }
    };
  }
})();

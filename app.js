/* Orbitus Digital Twin: team chat, shared calendar and missions.
   Data lives in Supabase (see supabase/setup.sql). With no config it runs
   in demo mode, saving sample data in this browser only. */
(function () {
  "use strict";

  var TABLES = ["profiles", "messages", "events", "missions", "reactions"];
  var CATEGORIES = ["Design", "Manufacturing", "Enterprise", "Portfolio"];
  var EMOJI = ["👍", "❤️", "😂", "🎉", "🔥", "👀"];
  var INLINE_IMAGES = /^image\/(png|jpe?g|gif|webp|avif)$/;
  var MAX_FILE = 10 * 1024 * 1024;
  var TITLE = "Orbitus";

  // read before the Supabase client tidies the address bar
  var startHash = location.hash;
  var recovering = /type=recovery/.test(startHash);
  var linkError = (startHash.match(/error_description=([^&]+)/) || [])[1];

  var cfg = window.ORBITUS_CONFIG || {};
  var store = cfg.url && cfg.anonKey ? supaStore(cfg) : demoStore();
  var app = document.getElementById("app");

  var state = {
    user: null,
    tab: "chat",
    profiles: [], messages: [], events: [], missions: [], reactions: [],
    month: startOfMonth(new Date()),
    day: ymd(new Date()),
    filter: "open",
    cat: "all",
    openMsg: null,
    replyTo: null,
    file: null,
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
  function fail(err) { toast((err && err.message) || "Something went wrong. Try again."); }
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
  function wordmark() { return h("div", { class: "wordmark" }, "ORB", h("i", null, "!"), "TUS"); }

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
        msg.textContent = /invalid/i.test(err.message || "") ? "That email or password is not right." : (err.message || "Could not sign in.");
      });
    } },
      wordmark(),
      h("p", { class: "mono sub" }, "Digital twin"),
      h("label", { for: "email" }, "Email"), email,
      h("label", { for: "pass" }, "Password"), pass,
      btn,
      h("button", { class: "linkish", type: "button", onclick: function () { showForgot(email.value.trim()); } }, "Forgot password?"),
      msg,
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
        say(msg, /rate|seconds/i.test(err.message || "") ? "Too many reset emails. Wait a few minutes and try again." : (err.message || "Could not send the email."));
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
      }, function (err) { btn.disabled = false; say(msg, err.message || "Could not save the password."); });
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
    }).catch(function (err) { state.user = null; showLogin((err && err.message) || "Could not load the workspace."); });
  }
  function leave() {
    if (stopWatching) { stopWatching(); stopWatching = null; }
    state.user = null; state.replyTo = null; state.file = null; state.urls = {}; ui = {};
    document.title = TITLE;
  }
  function load(table) {
    return store.list(table).then(function (rows) { state[table] = rows; });
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
        .catch(function (err) { msg.textContent = err.message || "Could not save."; });
    } },
      wordmark(),
      h("label", { for: "nm" }, "What should the team call you?"), input,
      h("button", { class: "btn primary", type: "submit" }, "Continue"), msg)));
    input.focus();
  }

  /* ---------- shell ---------- */
  var ICONS = {
    chat: "M4 5h16v11H9l-5 4z",
    calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
    missions: "M4 6l2 2 3-3M4 13l2 2 3-3M13 7h7M13 14h7M4 20h16",
    settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5",
    clip: "M16.5 7.5l-7.8 7.8a2.1 2.1 0 0 0 3 3l8.1-8.1a4.2 4.2 0 0 0-6-6L5.6 12.4a6.3 6.3 0 0 0 8.9 8.9l6-6",
    edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
    download: "M12 4v11M7 10l5 5 5-5M5 20h14",
    file: "M7 3h7l5 5v13H7zM14 3v5h5"
  };
  function icon(name) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg"), p = document.createElementNS(ns, "path");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    p.setAttribute("d", ICONS[name]); svg.append(p);
    return svg;
  }
  function iconBtn(name, label, onclick) {
    return h("button", { class: "ibtn", type: "button", "aria-label": label, title: label, onclick: onclick }, icon(name));
  }

  function buildShell() {
    ui = {};
    ui.tabs = {};
    ui.views = { chat: chatView(), calendar: calendarView(), missions: missionsView(), settings: settingsView() };
    var nav = h("nav", { class: "tabs", "aria-label": "Sections" }, ["chat", "calendar", "missions", "settings"].map(function (t) {
      var label = t.charAt(0).toUpperCase() + t.slice(1);
      var dot = t === "chat" ? (ui.unread = h("b", { class: "unread", hidden: true })) : null;
      return (ui.tabs[t] = h("button", { type: "button", onclick: function () { go(t); } }, icon(t), h("span", null, label), dot));
    }));
    ui.acctName = h("span");
    ui.acctInit = h("b");
    var acct = h("button", { class: "acct", type: "button", onclick: function () { go("settings"); }, "aria-label": "Settings" }, ui.acctInit, ui.acctName);
    clear(app).append(h("div", { class: "shell" },
      h("div", { class: "brand" }, h("div", { class: "wordmark sm" }, "ORB", h("i", null, "!"), "TUS"), h("p", { class: "mono sub" }, "Digital twin")),
      acct, nav,
      h("main", { class: "main" },
        store.demo && h("p", { class: "demo-bar mono" }, "Demo mode · saved in this browser only"),
        ui.views.chat, ui.views.calendar, ui.views.missions, ui.views.settings)));
    TABLES.forEach(paint);
    go(state.tab);
    if (stopWatching) stopWatching();
    var unwatch = store.watch(refresh);
    var wake = function () { if (!document.hidden && state.tab === "chat") markSeen(); };
    document.addEventListener("visibilitychange", wake);
    stopWatching = function () { unwatch(); document.removeEventListener("visibilitychange", wake); };
  }

  function go(tab) {
    state.tab = tab;
    Object.keys(ui.views).forEach(function (t) {
      ui.views[t].hidden = t !== tab;
      if (t === tab) ui.tabs[t].setAttribute("aria-current", "page"); else ui.tabs[t].removeAttribute("aria-current");
    });
    if (tab === "chat") { markSeen(); scrollChat(); }
  }

  function paint(table) {
    if (!ui.views) return;
    if (table === "profiles") {
      var me = nameOf(state.user.id);
      ui.acctName.textContent = me; ui.acctInit.textContent = me.charAt(0).toUpperCase();
      paintChat(); paintCalendar(); paintMissions(); paintOwners(); paintSettings();
    }
    if (table === "messages" || table === "reactions") paintChat();
    if (table === "events") paintCalendar();
    if (table === "missions") { paintMissions(); paintCalendar(); }
  }

  /* ---------- editor sheet (events and missions) ---------- */
  function sheet(title, body, onSave) {
    var msg = h("p", { class: "form-msg", role: "alert" });
    var dlg = h("dialog", { class: "sheet" });
    function close() { dlg.close(); dlg.remove(); }
    dlg.append(h("form", { novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      var r = onSave();
      if (typeof r === "string") { say(msg, r); return; }
      r.then(close, function (err) { say(msg, err.message || "Could not save."); });
    } },
      h("h2", null, title), body, msg,
      h("div", { class: "row" },
        h("button", { class: "btn primary", type: "submit" }, "Save"),
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
    sheet("Edit event", [
      h("label", { for: "eTitle" }, "What"), title,
      h("div", { class: "pair" },
        h("div", null, h("label", { for: "eDay" }, "Day"), day),
        h("div", null, h("label", { for: "eAt" }, "Time (optional)"), at)),
      h("label", { for: "eNote" }, "Note"), note
    ], function () {
      if (!title.value.trim()) return "Add a title.";
      if (!day.value) return "Pick a day.";
      return store.update("events", ev.id, { title: title.value.trim(), day: day.value, at: at.value || null, note: note.value.trim() || null })
        .then(function () { state.day = day.value; state.month = startOfMonth(fromYmd(day.value)); refresh("events"); });
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
    var nameMsg = h("p", { class: "form-msg", role: "status" });
    var f = passwordFields([
      { text: "Current password", auto: "current-password" },
      { text: "New password", auto: "new-password", min: 8 },
      { text: "New password again", auto: "new-password", min: 8 }]);
    var cur = f.inputs[0], pw = f.inputs[1], pw2 = f.inputs[2];
    var pwMsg = h("p", { class: "form-msg", role: "status" });
    var pwBtn = h("button", { class: "btn primary", type: "submit" }, "Change password");

    return h("section", { class: "view settings", "aria-label": "Settings", hidden: true },
      h("header", { class: "view-h" }, h("h1", null, "Settings"), h("p", { class: "mono dim" }, "Your account")),
      h("div", { class: "set-grid" },
        h("form", { class: "card", novalidate: true, onsubmit: function (e) {
          e.preventDefault();
          var n = ui.setName.value.trim();
          if (!n) { say(nameMsg, "Name cannot be empty."); return; }
          store.saveName(state.user.id, n).then(function () { refresh("profiles"); say(nameMsg, "Name saved.", true); })
            .catch(function (err) { say(nameMsg, err.message || "Could not save."); });
        } },
          h("h2", null, "Profile"),
          h("label", null, "Signed in as"), h("p", { class: "set-email" }, state.user.email),
          h("label", { for: "setName" }, "Display name"), ui.setName,
          h("p", { class: "dim small hint" }, "Teammates mention you in chat by typing @ and this name."),
          h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Save name")), nameMsg),

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
            say(pwMsg, /invalid/i.test(err.message || "") ? "The current password is not right." : (err.message || "Could not change the password."));
          }).then(function () { pwBtn.disabled = false; });
        } },
          h("h2", null, "Password"), f.nodes,
          h("div", { class: "row" }, pwBtn), pwMsg),

        h("div", { class: "card" }, h("h2", null, "Team"), ui.team),

        h("div", { class: "card" },
          h("h2", null, "Sign out"),
          h("p", { class: "dim" }, "You will need your email and password to get back in."),
          h("div", { class: "row" }, h("button", { class: "btn danger", type: "button", onclick: function () {
            store.signOut().then(function () { leave(); showLogin(); });
          } }, "Sign out")))));
  }
  function paintSettings() {
    if (!ui.team) return;
    if (document.activeElement !== ui.setName) ui.setName.value = nameOf(state.user.id);
    clear(ui.team);
    state.profiles.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (p) {
      ui.team.append(h("li", null, h("b", null, p.name.charAt(0).toUpperCase()), h("span", null, p.name),
        p.id === state.user.id && h("i", { class: "mono" }, "You")));
    });
  }

  /* ---------- chat ---------- */
  function chatView() {
    ui.msgs = h("div", { class: "msgs", role: "log", "aria-live": "polite", tabindex: "0" });
    ui.box = h("textarea", { rows: 1, maxlength: 2000, placeholder: "Message the team", "aria-label": "Message" });
    ui.replyBar = h("div", { class: "pending", hidden: true });
    ui.fileBar = h("div", { class: "pending", hidden: true });
    ui.suggest = h("div", { class: "suggest", role: "listbox", "aria-label": "Mention someone", hidden: true });
    ui.send = h("button", { class: "btn primary", type: "submit" }, "Send");
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
    box.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !ui.suggest.hidden) { ui.suggest.hidden = true; return; }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        var first = ui.suggest.hidden ? null : ui.suggest.querySelector("button");
        if (first) first.click(); else send();
      }
    });
    ui.grow = grow;
    return h("section", { class: "view chat", "aria-label": "Chat" },
      h("header", { class: "view-h" }, h("h1", null, "Chat"), h("p", { class: "mono dim" }, "Team only")),
      ui.msgs,
      h("div", { class: "composer-wrap" },
        ui.suggest, ui.replyBar, ui.fileBar,
        h("form", { class: "composer", onsubmit: function (e) { e.preventDefault(); send(); box.focus(); } },
          iconBtn("clip", "Attach a photo or file", function () { picker.click(); }), picker,
          box, ui.send)));
  }

  function send() {
    var body = ui.box.value.trim(), file = state.file, reply = state.replyTo;
    if (!body && !file) return;
    ui.send.disabled = true;
    if (file) ui.send.textContent = "Sending…";
    var up = file ? store.upload(state.user.id, file) : Promise.resolve(null);
    up.then(function (path) {
      var row = { user_id: state.user.id, body: body, reply_to: reply ? reply.id : null };
      if (path) { row.file_path = path; row.file_name = file.name.slice(0, 200); row.file_type = (file.type || "application/octet-stream").slice(0, 120); row.file_size = file.size; }
      return store.add("messages", row);
    }).then(function () {
      ui.box.value = ""; ui.grow();
      state.file = null; state.replyTo = null; paintPending();
      refresh("messages");
    }).catch(fail).then(function () { ui.send.disabled = false; ui.send.textContent = "Send"; });
  }

  function paintPending() {
    var r = state.replyTo, f = state.file;
    clear(ui.replyBar).hidden = !r;
    if (r) ui.replyBar.append(
      h("div", null, h("p", { class: "mono" }, "Replying to " + nameOf(r.user_id)), h("p", { class: "clip" }, snippet(r))),
      h("button", { class: "x", type: "button", "aria-label": "Cancel reply", onclick: function () { state.replyTo = null; paintPending(); } }, "×"));
    clear(ui.fileBar).hidden = !f;
    if (f) ui.fileBar.append(
      h("div", null, h("p", { class: "mono" }, "Attached"), h("p", { class: "clip" }, f.name + " · " + fmtSize(f.size))),
      h("button", { class: "x", type: "button", "aria-label": "Remove attachment", onclick: function () { state.file = null; paintPending(); } }, "×"));
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
  function fetchUrls() {
    var need = state.messages.filter(function (m) { return m.file_path && !(m.file_path in state.urls); })
      .map(function (m) { return m.file_path; });
    if (!need.length) return;
    need.forEach(function (p) { state.urls[p] = null; });
    store.fileUrls(need).then(function (map) {
      Object.keys(map).forEach(function (p) { state.urls[p] = map[p]; });
      paintChat();
    }).catch(function () { need.forEach(function (p) { delete state.urls[p]; }); });
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

  function paintChat() {
    if (!ui.msgs) return;
    var el = ui.msgs;
    var nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    ui.stick = nearBottom;
    var re = mentionRe(), myName = nameOf(state.user.id).toLowerCase();
    clear(el);
    if (!state.messages.length) el.append(h("p", { class: "empty" }, "No messages yet. Say hello."));
    var lastDay = "", prev = null;
    state.messages.forEach(function (m) {
      var d = new Date(m.created_at), day = ymd(d), mine = m.user_id === state.user.id;
      if (day !== lastDay) { el.append(h("p", { class: "daysep mono" }, day === ymd(new Date()) ? "Today" : fmtDay(day))); lastDay = day; prev = null; }
      var joined = prev && !m.reply_to && prev.user_id === m.user_id && d - new Date(prev.created_at) < 5 * 60 * 1000;
      var open = state.openMsg === m.id;
      var quoted = m.reply_to ? byId(state.messages, m.reply_to) : null;
      var bubble = h("div", { class: "bubble", tabindex: "0", role: "button", "aria-expanded": open ? "true" : "false",
        "aria-label": (mine ? "Your message" : "Message from " + nameOf(m.user_id)) + ". Press for reactions and reply." },
        m.reply_to && h("button", { class: "quote", type: "button", onclick: function (e) {
          e.stopPropagation();
          var target = document.getElementById("m-" + m.reply_to);
          if (target) { target.scrollIntoView({ block: "center", behavior: "smooth" }); target.classList.add("flash"); setTimeout(function () { target.classList.remove("flash"); }, 1400); }
        } }, quoted ? [h("b", null, nameOf(quoted.user_id)), " ", snippet(quoted)] : "Original message was deleted"),
        m.file_path && attachment(m),
        m.body && h("div", { class: "text" }, richText(m.body, re, myName)));
      var toggle = function (e) {
        if (e.target.closest("a, .quote")) return;
        state.openMsg = open ? null : m.id; paintChat();
      };
      bubble.addEventListener("click", toggle);
      bubble.addEventListener("keydown", function (e) { if (e.target === bubble && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(e); } });

      var groups = reactionsFor(m.id), emojis = Object.keys(groups);
      var row = h("div", { id: "m-" + m.id, class: "msg" + (mine ? " mine" : "") + (joined ? " joined" : "") + (open ? " open" : "") + (!mine && mentionsMe(m, re, myName) ? " mention" : "") },
        !joined && h("p", { class: "msg-h mono" }, mine ? "You" : nameOf(m.user_id), " · ", fmtTime(d)),
        bubble,
        emojis.length ? h("div", { class: "reacts" }, emojis.map(function (em) {
          var who = groups[em], minePick = who.indexOf(state.user.id) >= 0;
          return h("button", { type: "button", class: "react" + (minePick ? " on" : ""), "aria-pressed": minePick ? "true" : "false",
            title: who.map(nameOf).join(", "), "aria-label": em + " " + who.length + ", " + who.map(nameOf).join(", "),
            onclick: function () { toggleReaction(m, em); } }, em, h("span", null, who.length));
        })) : null,
        open && h("div", { class: "actions" },
          EMOJI.map(function (em) { return h("button", { type: "button", class: "pick", "aria-label": "React " + em, onclick: function () { state.openMsg = null; toggleReaction(m, em); } }, em); }),
          m.file_path && state.urls[m.file_path] && h("a", { class: "act mono", href: state.urls[m.file_path], target: "_blank", rel: "noopener noreferrer" },
            INLINE_IMAGES.test(m.file_type || "") ? "Open photo" : "Open file"),
          h("button", { type: "button", class: "act mono", onclick: function () {
            state.replyTo = m; state.openMsg = null; paintPending(); paintChat(); ui.box.focus();
          } }, "Reply"),
          mine && h("button", { type: "button", class: "act mono danger", onclick: function () {
            var path = m.file_path;
            store.remove("messages", m.id).then(function () {
              if (path) store.removeFile(path).catch(function () {});
              state.openMsg = null; refresh("messages");
            }).catch(fail);
          } }, "Delete")));
      el.append(row);
      prev = m;
    });
    fetchUrls();
    if (state.tab === "chat" && !document.hidden) markSeen();
    else markUnread();
    if (nearBottom) scrollChat();
  }
  function scrollChat() { if (ui.msgs) ui.msgs.scrollTop = ui.msgs.scrollHeight; }
  function lastMsgId() { return state.messages.length ? state.messages[state.messages.length - 1].id : 0; }
  function markSeen() { setSeen(lastMsgId()); markUnread(); }
  function markUnread() {
    var seen = getSeen(), me = state.user && state.user.id;
    var n = state.messages.filter(function (m) { return m.id > seen && m.user_id !== me; }).length;
    if (ui.unread) { ui.unread.hidden = !n; ui.unread.setAttribute("aria-label", n + " new messages"); }
    document.title = n ? "(" + n + ") " + TITLE : TITLE;
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
  function icsEvent(uid, day, at, summary, desc) {
    var lines = ["BEGIN:VEVENT", "UID:" + uid + "@orbitus", "DTSTAMP:" + icsStamp()];
    if (at) {
      var p = at.split(":"), start = fromYmd(day);
      start.setHours(+p[0], +p[1]);
      lines.push("DTSTART:" + icsLocal(start), "DTEND:" + icsLocal(new Date(start.getTime() + 3600000)));
    } else {
      var next = fromYmd(day); next.setDate(next.getDate() + 1);
      lines.push("DTSTART;VALUE=DATE:" + icsDate(day), "DTEND;VALUE=DATE:" + icsDate(ymd(next)));
    }
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
  function eventIcs(ev) { return icsEvent("event-" + ev.id, ev.day, ev.at && ev.at.slice(0, 5), ev.title, ev.note); }
  function missionIcs(m) { return icsEvent("mission-" + m.id, m.due, null, "Due: " + m.title, m.category ? m.category + " mission" : "Mission"); }
  function exportAll() {
    var all = state.events.map(eventIcs).concat(state.missions.filter(function (m) { return m.due && !m.done; }).map(missionIcs));
    if (!all.length) { toast("Nothing to export yet."); return; }
    downloadIcs("orbitus.ics", [all]);
    toast("Downloaded. Open the file to add it to your calendar.");
  }

  /* ---------- calendar ---------- */
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
              state.month = startOfMonth(new Date()); state.day = ymd(new Date()); paintCalendar();
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
            store.add("events", { user_id: state.user.id, title: t, day: state.day, at: time.value || null, note: note.value.trim() || null })
              .then(function () { title.value = ""; time.value = ""; note.value = ""; refresh("events"); }).catch(fail);
          } }, title, h("div", { class: "row" }, time, note), h("button", { class: "btn primary", type: "submit" }, "Add to this day")),
          h("h3", { class: "mono" }, "Coming up"), ui.upcoming)));
  }
  function evSort(a, b) { return (a.day + (a.at || "")).localeCompare(b.day + (b.at || "")) || a.id - b.id; }
  function evItem(ev, withDay) {
    return h("li", null,
      h("span", { class: "ev-when mono" }, withDay ? fmtDay(ev.day) + (ev.at ? " · " : "") : "", ev.at ? ev.at.slice(0, 5) : (withDay ? "" : "All day")),
      h("div", null, h("strong", null, ev.title), ev.note && h("p", null, ev.note), h("p", { class: "mono dim" }, "Added by " + nameOf(ev.user_id))),
      h("div", { class: "tools" },
        iconBtn("edit", "Edit " + ev.title, function () { editEvent(ev); }),
        iconBtn("download", "Add " + ev.title + " to my calendar", function () { downloadIcs("orbitus-event.ics", [eventIcs(ev)]); }),
        h("button", { class: "x", type: "button", "aria-label": "Delete " + ev.title, onclick: function () {
          store.remove("events", ev.id).then(function () { refresh("events"); }).catch(fail);
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
    var y = state.month.getFullYear(), m = state.month.getMonth(), today = ymd(new Date());
    ui.calTitle.textContent = state.month.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    var counts = {}, dues = {};
    state.events.forEach(function (e) { counts[e.day] = (counts[e.day] || 0) + 1; });
    state.missions.forEach(function (x) { if (x.due && !x.done) dues[x.due] = (dues[x.due] || 0) + 1; });
    clear(ui.calGrid);
    var offset = (new Date(y, m, 1).getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
    for (var i = 0; i < offset; i++) ui.calGrid.append(h("span", { class: "cell blank" }));
    for (var d = 1; d <= days; d++) (function (d) {
      var key = y + "-" + pad(m + 1) + "-" + pad(d), n = counts[key] || 0, k = dues[key] || 0;
      var label = fmtDay(key, true) + (n ? ", " + n + (n === 1 ? " event" : " events") : "") + (k ? ", " + k + (k === 1 ? " mission due" : " missions due") : "");
      ui.calGrid.append(h("button", {
        class: "cell" + (key === today ? " today" : "") + (key === state.day ? " sel" : ""), type: "button",
        "aria-pressed": key === state.day ? "true" : "false", "aria-label": label,
        onclick: function () { state.day = key; paintCalendar(); }
      }, h("span", null, d), (n || k) ? h("i", { class: "dots" },
        n ? h("b", { class: "k-ev" }, n > 3 ? n : new Array(n + 1).join("•")) : null,
        k ? h("b", { class: "k-m" }, k > 3 ? k : new Array(k + 1).join("•")) : null) : null));
    })(d);

    ui.dayTitle.textContent = fmtDay(state.day, true);
    clear(ui.dayList);
    var todays = state.events.filter(function (e) { return e.day === state.day; }).sort(evSort);
    var dueToday = state.missions.filter(function (x) { return x.due === state.day; }).sort(missionSort);
    if (!todays.length) ui.dayList.append(h("li", { class: "empty" }, dueToday.length ? "No events." : "Nothing planned."));
    todays.forEach(function (e) { ui.dayList.append(evItem(e, false)); });
    clear(ui.dayMissions);
    ui.dayMissionsH.hidden = ui.dayMissions.hidden = !dueToday.length;
    dueToday.forEach(function (x) { ui.dayMissions.append(missionItem(x)); });

    clear(ui.upcoming);
    var next = state.events.filter(function (e) { return e.day >= today; }).map(function (e) { return { day: e.day, at: e.at || "", node: function () { return evItem(e, true); } }; })
      .concat(state.missions.filter(function (x) { return x.due && x.due >= today && !x.done; }).map(function (x) { return { day: x.due, at: "", node: function () { return dueItem(x); } }; }))
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
      h("div", { class: "chips", role: "group", "aria-label": "Show" }, [["open", "To do"], ["done", "Done"], ["all", "All"]].map(function (f) {
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
    var rows = inCat.filter(function (m) { return state.filter === "all" || (state.filter === "done") === m.done; }).sort(missionSort);
    clear(ui.mList);
    if (!rows.length) ui.mList.append(h("li", { class: "empty" },
      state.filter === "done" ? "Nothing ticked off yet." : state.filter === "open" && inCat.length ? "All clear. Every mission here is done." : "No missions here yet. Add one above."));
    rows.forEach(function (m) { ui.mList.append(missionItem(m)); });
  }

  /* ---------- stores ---------- */
  function supaStore(cfg) {
    var sb = window.supabase.createClient(cfg.url, cfg.anonKey);
    var bucket = function () { return sb.storage.from("chat-files"); };
    function pick(u) { return u ? { id: u.id, email: u.email } : null; }
    function ok(res) { if (res.error) throw res.error; return res.data; }
    var orders = {
      profiles: function (q) { return q.order("name"); },
      messages: function (q) { return q.order("id", { ascending: false }).limit(300); },
      events: function (q) { return q.order("day"); },
      missions: function (q) { return q.order("id"); },
      reactions: function (q) { return q.order("created_at", { ascending: false }).limit(3000); }
    };
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
      list: function (t) { return orders[t](sb.from(t).select("*")).then(function (r) { var d = ok(r); return t === "messages" ? d.reverse() : d; }); },
      add: function (t, row) { return sb.from(t).insert(row).then(ok); },
      update: function (t, id, patch) { return sb.from(t).update(patch).eq("id", id).then(ok); },
      remove: function (t, id) { return sb.from(t).delete().eq("id", id).then(ok); },
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
    var KEY = "orbitus-demo-2", ME = "me", db;
    function day(n) { var d = new Date(); d.setDate(d.getDate() + n); return ymd(d); }
    function ago(mins) { return new Date(Date.now() - mins * 60000).toISOString(); }
    function seed() {
      return {
        seq: 100, signedIn: false, email: "", files: {},
        profiles: [{ id: "a", name: "Aariv" }, { id: "b", name: "Aryeh" }, { id: "c", name: "Rehnuma" }, { id: "d", name: "Vivaan" }, { id: "e", name: "Aarna" }],
        messages: [
          { id: 1, user_id: "b", body: "Front wing print finished overnight. Bringing it in tomorrow.", created_at: ago(1500) },
          { id: 2, user_id: "e", body: "Portfolio pages 4 to 9 are ready for review. @Aariv can you check the sponsor page?", created_at: ago(190) },
          { id: 3, user_id: "d", body: "Can everyone add their free slots to the calendar for track testing?", created_at: ago(42) },
          { id: 4, user_id: "c", body: "Thursday after school works for me.", reply_to: 3, created_at: ago(30) }
        ],
        reactions: [{ message_id: 1, user_id: "d", emoji: "🔥" }, { message_id: 1, user_id: "e", emoji: "🔥" }, { message_id: 3, user_id: "a", emoji: "👍" }],
        events: [
          { id: 5, user_id: "d", title: "Track testing", day: day(2), at: "15:30", note: "Bring both cars and the spare cartridges." },
          { id: 6, user_id: "e", title: "Portfolio review", day: day(0), at: "17:00", note: null },
          { id: 7, user_id: "a", title: "Sponsor call", day: day(6), at: null, note: "Time to be confirmed." }
        ],
        missions: [
          { id: 8, user_id: "b", title: "Sand and prime the new body", owner: "c", category: "Manufacturing", due: day(1), done: false, done_by: null, done_at: null },
          { id: 9, user_id: "e", title: "Proofread the enterprise portfolio", owner: null, category: "Portfolio", due: day(4), done: false, done_by: null, done_at: null },
          { id: 11, user_id: "d", title: "Update the pit display sketches", owner: "d", category: "Design", due: day(-1), done: false, done_by: null, done_at: null },
          { id: 10, user_id: "a", title: "Send thank-you notes to sponsors", owner: "a", category: "Enterprise", due: null, done: true, done_by: "a", done_at: ago(600) }
        ]
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
        db[t].push(row); return done();
      },
      update: function (t, id, patch) { db[t].forEach(function (r) { if (r.id === id) Object.assign(r, patch); }); return done(); },
      remove: function (t, id) {
        db[t] = db[t].filter(function (r) { return r.id !== id; });
        if (t === "messages") {
          db.reactions = db.reactions.filter(function (r) { return r.message_id !== id; });
          db.messages.forEach(function (m) { if (m.reply_to === id) m.reply_to = null; });
        }
        return done();
      },
      react: function (mid, uid, emoji) { db.reactions.push({ message_id: mid, user_id: uid, emoji: emoji }); return done(); },
      unreact: function (mid, uid, emoji) {
        db.reactions = db.reactions.filter(function (r) { return !(r.message_id === mid && r.user_id === uid && r.emoji === emoji); });
        return done();
      },
      upload: function (uid, file) {
        if (file.size > 1.5 * 1024 * 1024) return Promise.reject(new Error("Demo mode keeps files under 1.5 MB."));
        return new Promise(function (resolve, reject) {
          var r = new FileReader();
          r.onload = function () { var path = uid + "/" + Date.now() + "-" + file.name; db.files[path] = r.result; done(path).then(resolve, reject); };
          r.onerror = function () { reject(new Error("Could not read that file.")); };
          r.readAsDataURL(file);
        });
      },
      fileUrls: function (paths) {
        var map = {};
        paths.forEach(function (p) { if (db.files[p]) map[p] = db.files[p]; });
        return Promise.resolve(map);
      },
      removeFile: function (path) { delete db.files[path]; return done(); },
      saveName: function (id, name) {
        var p = db.profiles.filter(function (r) { return r.id === id; })[0];
        if (p) p.name = name; else db.profiles.push({ id: id, name: name });
        return done();
      },
      watch: function () { return function () {}; }
    };
  }
})();

/* Orbitus Digital Twin: team chat, shared calendar and missions.
   Data lives in Supabase (see supabase/setup.sql). With no config it runs
   in demo mode, saving sample data in this browser only. */
(function () {
  "use strict";

  var TABLES = ["profiles", "messages", "events", "missions"];
  var cfg = window.ORBITUS_CONFIG || {};
  var store = cfg.url && cfg.anonKey ? supaStore(cfg) : demoStore();
  var app = document.getElementById("app");

  var state = {
    user: null,
    tab: "chat",
    profiles: [], messages: [], events: [], missions: [],
    month: startOfMonth(new Date()),
    day: ymd(new Date()),
    filter: "open",
    openMsg: null
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
  function nameOf(id) {
    for (var i = 0; i < state.profiles.length; i++) if (state.profiles[i].id === id) return state.profiles[i].name;
    return "Someone";
  }
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

  /* ---------- boot ---------- */
  store.session().then(function (user) {
    if (user) enter(user); else showLogin();
  }).catch(function () { showLogin(); });

  store.onSignedOut(function () {
    if (state.user) { leave(); showLogin("You have been signed out."); }
  });

  /* ---------- login ---------- */
  function showLogin(note) {
    var email = h("input", { type: "email", id: "email", autocomplete: "username", required: true, placeholder: "you@example.com" });
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
      h("div", { class: "wordmark" }, "ORB", h("i", null, "!"), "TUS"),
      h("p", { class: "mono sub" }, "Digital twin"),
      h("label", { for: "email" }, "Email"), email,
      h("label", { for: "pass" }, "Password"), pass,
      btn, msg,
      store.demo && h("p", { class: "demo-note" }, "Demo mode: not connected yet. Any email and password opens a sample workspace that is saved only in this browser.")
    );
    clear(app).append(h("main", { class: "login" }, form, h("p", { class: "mono dim" }, "Members only")));
    email.focus();
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
    state.user = null; ui = {};
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
      h("div", { class: "wordmark" }, "ORB", h("i", null, "!"), "TUS"),
      h("label", { for: "nm" }, "What should the team call you?"), input,
      h("button", { class: "btn primary", type: "submit" }, "Continue"), msg)));
    input.focus();
  }

  /* ---------- shell ---------- */
  var ICONS = {
    chat: "M4 5h16v11H9l-5 4z",
    calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
    missions: "M4 6l2 2 3-3M4 13l2 2 3-3M13 7h7M13 14h7M4 20h16"
  };
  function icon(name) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg"), p = document.createElementNS(ns, "path");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    p.setAttribute("d", ICONS[name]); svg.append(p);
    return svg;
  }

  function buildShell() {
    ui = {};
    ui.tabs = {};
    ui.views = { chat: chatView(), calendar: calendarView(), missions: missionsView() };
    var nav = h("nav", { class: "tabs", "aria-label": "Sections" }, ["chat", "calendar", "missions"].map(function (t) {
      var label = t.charAt(0).toUpperCase() + t.slice(1);
      var dot = t === "chat" ? (ui.unread = h("b", { class: "unread", hidden: true, "aria-label": "new messages" })) : null;
      return (ui.tabs[t] = h("button", { type: "button", onclick: function () { go(t); } }, icon(t), h("span", null, label), dot));
    }));
    ui.acctName = h("span");
    ui.acctInit = h("b");
    var acct = h("button", { class: "acct", type: "button", onclick: openAccount, "aria-label": "Account" }, ui.acctInit, ui.acctName);
    clear(app).append(h("div", { class: "shell" },
      h("div", { class: "brand" }, h("div", { class: "wordmark sm" }, "ORB", h("i", null, "!"), "TUS"), h("p", { class: "mono sub" }, "Digital twin")),
      acct, nav,
      h("main", { class: "main" },
        store.demo && h("p", { class: "demo-bar mono" }, "Demo mode · saved in this browser only"),
        ui.views.chat, ui.views.calendar, ui.views.missions)));
    TABLES.forEach(paint);
    go(state.tab);
    if (stopWatching) stopWatching();
    stopWatching = store.watch(refresh);
  }

  function go(tab) {
    state.tab = tab;
    Object.keys(ui.views).forEach(function (t) {
      ui.views[t].hidden = t !== tab;
      if (t === tab) ui.tabs[t].setAttribute("aria-current", "page"); else ui.tabs[t].removeAttribute("aria-current");
    });
    if (tab === "chat") { markSeen(); scrollChat(true); }
  }

  function paint(table) {
    if (!ui.views) return;
    if (table === "profiles") {
      var me = nameOf(state.user.id);
      ui.acctName.textContent = me; ui.acctInit.textContent = me.charAt(0).toUpperCase();
      paintChat(); paintCalendar(); paintMissions(); paintOwners();
    }
    if (table === "messages") paintChat();
    if (table === "events") paintCalendar();
    if (table === "missions") paintMissions();
  }

  /* ---------- account ---------- */
  function openAccount() {
    var name = h("input", { type: "text", id: "acName", maxlength: 40, value: nameOf(state.user.id) });
    var pw = h("input", { type: "password", id: "acPw", autocomplete: "new-password", minlength: 8, placeholder: "Leave empty to keep it" });
    var msg = h("p", { class: "form-msg", role: "alert" });
    var dlg = h("dialog", { class: "sheet" });
    function close() { dlg.close(); dlg.remove(); }
    dlg.append(h("form", { onsubmit: function (e) {
      e.preventDefault();
      var jobs = [], n = name.value.trim();
      if (!n) { msg.textContent = "Name cannot be empty."; return; }
      if (pw.value && pw.value.length < 8) { msg.textContent = "Use at least 8 characters."; return; }
      if (n !== nameOf(state.user.id)) jobs.push(store.saveName(state.user.id, n));
      if (pw.value) jobs.push(store.setPassword(pw.value));
      Promise.all(jobs).then(function () { refresh("profiles"); close(); if (jobs.length) toast("Saved."); })
        .catch(function (err) { msg.textContent = err.message || "Could not save."; });
    } },
      h("h2", null, "Account"),
      h("p", { class: "mono dim" }, state.user.email),
      h("label", { for: "acName" }, "Display name"), name,
      h("label", { for: "acPw" }, "New password"), pw,
      msg,
      h("div", { class: "row" },
        h("button", { class: "btn primary", type: "submit" }, "Save"),
        h("button", { class: "btn", type: "button", onclick: close }, "Cancel"),
        h("button", { class: "btn danger push", type: "button", onclick: function () {
          close(); store.signOut().then(function () { leave(); showLogin(); });
        } }, "Sign out"))));
    dlg.addEventListener("cancel", function () { dlg.remove(); });
    document.body.append(dlg); dlg.showModal();
  }

  /* ---------- chat ---------- */
  function chatView() {
    ui.msgs = h("div", { class: "msgs", role: "log", "aria-live": "polite", tabindex: "0" });
    var box = h("textarea", { rows: 1, maxlength: 2000, placeholder: "Message the team", "aria-label": "Message" });
    function send() {
      var body = box.value.trim();
      if (!body) return;
      box.value = ""; grow();
      store.add("messages", { user_id: state.user.id, body: body }).then(function () { refresh("messages"); })
        .catch(function (err) { box.value = body; fail(err); });
    }
    function grow() { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, 140) + "px"; }
    box.addEventListener("input", grow);
    box.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    return h("section", { class: "view chat", "aria-label": "Chat" },
      h("header", { class: "view-h" }, h("h1", null, "Chat"), h("p", { class: "mono dim" }, "Team only")),
      ui.msgs,
      h("form", { class: "composer", onsubmit: function (e) { e.preventDefault(); send(); box.focus(); } },
        box, h("button", { class: "btn primary", type: "submit" }, "Send")));
  }
  function linkify(text) {
    var out = [], re = /https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push(h("a", { href: m[0], target: "_blank", rel: "noopener noreferrer" }, m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  function paintChat() {
    if (!ui.msgs) return;
    var nearBottom = ui.msgs.scrollHeight - ui.msgs.scrollTop - ui.msgs.clientHeight < 80;
    clear(ui.msgs);
    if (!state.messages.length) ui.msgs.append(h("p", { class: "empty" }, "No messages yet. Say hello."));
    var lastDay = "", prev = null;
    state.messages.forEach(function (m) {
      var d = new Date(m.created_at), day = ymd(d), mine = m.user_id === state.user.id;
      if (day !== lastDay) { ui.msgs.append(h("p", { class: "daysep mono" }, day === ymd(new Date()) ? "Today" : fmtDay(day))); lastDay = day; prev = null; }
      var joined = prev && prev.user_id === m.user_id && d - new Date(prev.created_at) < 5 * 60 * 1000;
      var bubble = h("div", { class: "bubble" }, linkify(m.body));
      var row = h("div", { class: "msg" + (mine ? " mine" : "") + (joined ? " joined" : "") + (state.openMsg === m.id ? " open" : "") },
        !joined && h("p", { class: "msg-h mono" }, mine ? "You" : nameOf(m.user_id), " · ", fmtTime(d)),
        bubble);
      if (mine) {
        bubble.tabIndex = 0;
        bubble.setAttribute("role", "button");
        bubble.setAttribute("aria-label", "Your message. Press to show delete.");
        var toggle = function (e) {
          if (e.target.closest("a")) return;
          state.openMsg = state.openMsg === m.id ? null : m.id; paintChat();
        };
        bubble.addEventListener("click", toggle);
        bubble.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(e); } });
        row.append(h("button", { class: "msg-del mono", type: "button", onclick: function () {
          store.remove("messages", m.id).then(function () { state.openMsg = null; refresh("messages"); }).catch(fail);
        } }, "Delete"));
      }
      ui.msgs.append(row);
      prev = m;
    });
    if (state.tab === "chat") { markSeen(); if (nearBottom) scrollChat(); }
    else markUnread();
  }
  function scrollChat() { if (ui.msgs) ui.msgs.scrollTop = ui.msgs.scrollHeight; }
  function lastMsgId() { return state.messages.length ? state.messages[state.messages.length - 1].id : 0; }
  function markSeen() { setSeen(lastMsgId()); if (ui.unread) ui.unread.hidden = true; }
  function markUnread() {
    var last = state.messages[state.messages.length - 1];
    if (ui.unread) ui.unread.hidden = !(last && last.id > getSeen() && last.user_id !== state.user.id);
  }

  /* ---------- calendar ---------- */
  function calendarView() {
    ui.calTitle = h("h2", { class: "cal-title", "aria-live": "polite" });
    ui.calGrid = h("div", { class: "cal-grid" });
    ui.dayTitle = h("h2");
    ui.dayList = h("ul", { class: "ev-list" });
    ui.upcoming = h("ul", { class: "ev-list" });
    var title = h("input", { type: "text", maxlength: 120, required: true, placeholder: "What is happening?", "aria-label": "Event title" });
    var time = h("input", { type: "time", "aria-label": "Time (optional)" });
    var note = h("input", { type: "text", maxlength: 500, placeholder: "Note (optional)", "aria-label": "Note" });
    function shift(n) { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + n, 1); paintCalendar(); }
    return h("section", { class: "view calendar", "aria-label": "Calendar", hidden: true },
      h("header", { class: "view-h" }, h("h1", null, "Calendar"), h("p", { class: "mono dim" }, "Shared with the team")),
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
          ui.calGrid),
        h("div", { class: "day" },
          ui.dayTitle, ui.dayList,
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
      h("button", { class: "x", type: "button", "aria-label": "Delete " + ev.title, onclick: function () {
        store.remove("events", ev.id).then(function () { refresh("events"); }).catch(fail);
      } }, "×"));
  }
  function paintCalendar() {
    if (!ui.calGrid) return;
    var y = state.month.getFullYear(), m = state.month.getMonth(), today = ymd(new Date());
    ui.calTitle.textContent = state.month.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    var counts = {};
    state.events.forEach(function (e) { counts[e.day] = (counts[e.day] || 0) + 1; });
    clear(ui.calGrid);
    var offset = (new Date(y, m, 1).getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
    for (var i = 0; i < offset; i++) ui.calGrid.append(h("span", { class: "cell blank" }));
    for (var d = 1; d <= days; d++) (function (d) {
      var key = y + "-" + pad(m + 1) + "-" + pad(d), n = counts[key] || 0;
      ui.calGrid.append(h("button", {
        class: "cell" + (key === today ? " today" : "") + (key === state.day ? " sel" : ""), type: "button",
        "aria-pressed": key === state.day ? "true" : "false",
        "aria-label": fmtDay(key, true) + (n ? ", " + n + (n === 1 ? " event" : " events") : ""),
        onclick: function () { state.day = key; paintCalendar(); }
      }, h("span", null, d), n ? h("i", { class: "dots" }, n > 3 ? n : new Array(n + 1).join("•")) : null));
    })(d);

    ui.dayTitle.textContent = fmtDay(state.day, true);
    clear(ui.dayList);
    var todays = state.events.filter(function (e) { return e.day === state.day; }).sort(evSort);
    if (!todays.length) ui.dayList.append(h("li", { class: "empty" }, "Nothing planned."));
    todays.forEach(function (e) { ui.dayList.append(evItem(e, false)); });

    clear(ui.upcoming);
    var next = state.events.filter(function (e) { return e.day >= today; }).sort(evSort).slice(0, 5);
    if (!next.length) ui.upcoming.append(h("li", { class: "empty" }, "No upcoming events."));
    next.forEach(function (e) { ui.upcoming.append(evItem(e, true)); });
  }

  /* ---------- missions ---------- */
  function missionsView() {
    ui.progText = h("p", { class: "mono" });
    ui.progBar = h("i");
    ui.mList = h("ul", { class: "m-list" });
    ui.owner = h("select", { "aria-label": "Who owns it" });
    ui.filters = {};
    var title = h("input", { type: "text", maxlength: 200, required: true, placeholder: "Add a mission", "aria-label": "Mission" });
    return h("section", { class: "view missions", "aria-label": "Missions", hidden: true },
      h("header", { class: "view-h" }, h("h1", null, "Missions"), ui.progText),
      h("div", { class: "prog", "aria-hidden": "true" }, ui.progBar),
      h("form", { class: "m-form", onsubmit: function (e) {
        e.preventDefault();
        var t = title.value.trim();
        if (!t) { title.focus(); return; }
        store.add("missions", { user_id: state.user.id, title: t, owner: ui.owner.value || null })
          .then(function () { title.value = ""; refresh("missions"); }).catch(fail);
      } }, title, ui.owner, h("button", { class: "btn primary", type: "submit" }, "Add")),
      h("div", { class: "chips", role: "group", "aria-label": "Show" }, [["open", "To do"], ["done", "Done"], ["all", "All"]].map(function (f) {
        return (ui.filters[f[0]] = h("button", { type: "button", class: "chip mono", onclick: function () { state.filter = f[0]; paintMissions(); } }, f[1]));
      })),
      ui.mList);
  }
  function paintOwners() {
    if (!ui.owner) return;
    var keep = ui.owner.value;
    clear(ui.owner).append(h("option", { value: "" }, "Anyone"));
    state.profiles.slice().sort(function (a, b) { return a.name.localeCompare(b.name); })
      .forEach(function (p) { ui.owner.append(h("option", { value: p.id }, p.name)); });
    ui.owner.value = keep;
  }
  function paintMissions() {
    if (!ui.mList) return;
    var all = state.missions, done = all.filter(function (m) { return m.done; }).length;
    ui.progText.textContent = all.length ? done + " of " + all.length + " complete" : "Nothing yet";
    ui.progBar.style.width = (all.length ? Math.round(done / all.length * 100) : 0) + "%";
    Object.keys(ui.filters).forEach(function (f) { ui.filters[f].setAttribute("aria-pressed", f === state.filter ? "true" : "false"); });
    var rows = all.filter(function (m) { return state.filter === "all" || (state.filter === "done") === m.done; })
      .sort(function (a, b) {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return a.done ? new Date(b.done_at) - new Date(a.done_at) : a.id - b.id;
      });
    clear(ui.mList);
    if (!rows.length) ui.mList.append(h("li", { class: "empty" },
      state.filter === "done" ? "Nothing ticked off yet." : state.filter === "open" && all.length ? "All clear. Every mission is done." : "No missions yet. Add the first one above."));
    rows.forEach(function (m) {
      var meta = [m.owner ? nameOf(m.owner) : "Anyone"];
      if (m.done && m.done_by) meta.push("done by " + nameOf(m.done_by)); else meta.push("added by " + nameOf(m.user_id));
      ui.mList.append(h("li", { class: m.done ? "done" : "" },
        h("button", { class: "tick", type: "button", role: "checkbox", "aria-checked": m.done ? "true" : "false", "aria-label": m.title, onclick: function () {
          var patch = m.done ? { done: false, done_by: null, done_at: null }
                             : { done: true, done_by: state.user.id, done_at: new Date().toISOString() };
          store.update("missions", m.id, patch).then(function () { refresh("missions"); }).catch(fail);
        } }, m.done ? "✓" : ""),
        h("div", null, h("strong", null, m.title), h("p", { class: "mono dim" }, meta.join(" · "))),
        h("button", { class: "x", type: "button", "aria-label": "Delete " + m.title, onclick: function () {
          store.remove("missions", m.id).then(function () { refresh("missions"); }).catch(fail);
        } }, "×")));
    });
  }

  /* ---------- stores ---------- */
  function supaStore(cfg) {
    var sb = window.supabase.createClient(cfg.url, cfg.anonKey);
    function pick(u) { return u ? { id: u.id, email: u.email } : null; }
    function ok(res) { if (res.error) throw res.error; return res.data; }
    var orders = {
      profiles: function (q) { return q.order("name"); },
      messages: function (q) { return q.order("id", { ascending: false }).limit(300); },
      events: function (q) { return q.order("day"); },
      missions: function (q) { return q.order("id"); }
    };
    return {
      demo: false,
      session: function () { return sb.auth.getSession().then(function (r) { return pick(r.data.session && r.data.session.user); }); },
      signIn: function (email, password) { return sb.auth.signInWithPassword({ email: email, password: password }).then(function (r) { return pick(ok(r).user); }); },
      signOut: function () { return sb.auth.signOut().then(function () {}); },
      onSignedOut: function (cb) { sb.auth.onAuthStateChange(function (ev) { if (ev === "SIGNED_OUT") cb(); }); },
      setPassword: function (p) { return sb.auth.updateUser({ password: p }).then(ok); },
      isTeam: function () { return sb.rpc("is_team").then(ok); },
      list: function (t) { return orders[t](sb.from(t).select("*")).then(function (r) { var d = ok(r); return t === "messages" ? d.reverse() : d; }); },
      add: function (t, row) { return sb.from(t).insert(row).then(ok); },
      update: function (t, id, patch) { return sb.from(t).update(patch).eq("id", id).then(ok); },
      remove: function (t, id) { return sb.from(t).delete().eq("id", id).then(ok); },
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
    var KEY = "orbitus-demo", ME = "me", db, listener = null;
    function day(n) { var d = new Date(); d.setDate(d.getDate() + n); return ymd(d); }
    function ago(mins) { return new Date(Date.now() - mins * 60000).toISOString(); }
    function seed() {
      return {
        seq: 100, signedIn: false, email: "",
        profiles: [{ id: "a", name: "Aariv" }, { id: "b", name: "Aryeh" }, { id: "c", name: "Rehnuma" }, { id: "d", name: "Vivaan" }, { id: "e", name: "Aarna" }],
        messages: [
          { id: 1, user_id: "b", body: "Front wing print finished overnight. Bringing it in tomorrow.", created_at: ago(1500) },
          { id: 2, user_id: "e", body: "Portfolio pages 4 to 9 are ready for review.", created_at: ago(190) },
          { id: 3, user_id: "d", body: "Can everyone add their free slots to the calendar for track testing?", created_at: ago(42) },
          { id: 4, user_id: "d", body: "Thursday after school works for me.", created_at: ago(41) }
        ],
        events: [
          { id: 5, user_id: "d", title: "Track testing", day: day(2), at: "15:30", note: "Bring both cars and the spare cartridges." },
          { id: 6, user_id: "e", title: "Portfolio review", day: day(0), at: "17:00", note: null },
          { id: 7, user_id: "a", title: "Sponsor call", day: day(6), at: null, note: "Time to be confirmed." }
        ],
        missions: [
          { id: 8, user_id: "b", title: "Sand and prime the new body", owner: "c", done: false, done_by: null, done_at: null },
          { id: 9, user_id: "e", title: "Proofread the enterprise portfolio", owner: null, done: false, done_by: null, done_at: null },
          { id: 10, user_id: "a", title: "Send thank-you notes to sponsors", owner: "a", done: true, done_by: "a", done_at: ago(600) }
        ]
      };
    }
    try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    if (!db || !db.profiles) db = seed();
    function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }
    function done(v) { save(); return Promise.resolve(v); }
    function user() { return { id: ME, email: db.email }; }
    return {
      demo: true,
      session: function () { return Promise.resolve(db.signedIn ? user() : null); },
      signIn: function (email) { db.signedIn = true; db.email = email; return done(user()); },
      signOut: function () { db.signedIn = false; return done(); },
      onSignedOut: function () {},
      setPassword: function () { return Promise.resolve(); },
      isTeam: function () { return Promise.resolve(true); },
      list: function (t) { return Promise.resolve(JSON.parse(JSON.stringify(db[t]))); },
      add: function (t, row) { row.id = ++db.seq; row.created_at = new Date().toISOString(); if (t === "missions") { row.done = false; row.done_by = null; row.done_at = null; } db[t].push(row); return done(); },
      update: function (t, id, patch) { db[t].forEach(function (r) { if (r.id === id) Object.assign(r, patch); }); return done(); },
      remove: function (t, id) { db[t] = db[t].filter(function (r) { return r.id !== id; }); return done(); },
      saveName: function (id, name) {
        var p = db.profiles.filter(function (r) { return r.id === id; })[0];
        if (p) p.name = name; else db.profiles.push({ id: id, name: name });
        return done();
      },
      watch: function (cb) { listener = cb; return function () { listener = null; }; }
    };
  }
})();

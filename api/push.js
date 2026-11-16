/* Sends phone notifications for new chat messages.

   The browser calls this right after a message is saved, passing the
   sender's own sign-in token. Everything here is done with that token, so
   the database's team-only rules still apply: a stranger gets nothing.

   POST { action: "key" }                   -> { publicKey }   (creates the key pair on first use)
   POST { action: "notify", message_id }    -> { sent, skipped, removed } */
const webpush = require("web-push");
const config = require("../config.js");

const SITE = "https://orbitusdigitaltwin.vercel.app";

function api(token, path, options) {
  const o = options || {};
  return fetch(config.url + path, {
    method: o.method || "GET",
    headers: Object.assign({
      apikey: config.anonKey,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    }, o.headers || {}),
    body: o.body ? JSON.stringify(o.body) : undefined
  }).then(function (r) {
    return r.text().then(function (t) {
      let data = null;
      try { data = t ? JSON.parse(t) : null; } catch (e) {}
      if (!r.ok) { const err = new Error((data && (data.message || data.msg)) || "Request failed"); err.status = r.status; throw err; }
      return data;
    });
  });
}

async function keys(token) {
  let rows = await api(token, "/rest/v1/push_keys?select=public_key,private_key&id=eq.1");
  if (!rows.length) {
    const k = webpush.generateVAPIDKeys();
    await api(token, "/rest/v1/push_keys", {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates" },
      body: { id: 1, public_key: k.publicKey, private_key: k.privateKey }
    });
    rows = await api(token, "/rest/v1/push_keys?select=public_key,private_key&id=eq.1");
  }
  if (!rows.length) { const err = new Error("Not on the team list."); err.status = 403; throw err; }
  return rows[0];
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function preview(m) {
  if (m.poll && m.poll.q) return "📊 " + m.poll.q;
  const text = (m.body || "").replace(/\s+/g, " ").trim();
  if (text) return text.length > 120 ? text.slice(0, 120) + "…" : text;
  return m.file_name ? "📎 " + m.file_name : "New message";
}

async function notify(token, messageId) {
  const me = await api(token, "/auth/v1/user");
  const found = await api(token, "/rest/v1/messages?select=id,user_id,body,file_name,poll,created_at&id=eq." + encodeURIComponent(messageId));
  const m = found[0];
  if (!m || m.user_id !== me.id) { const err = new Error("That is not your message."); err.status = 403; throw err; }
  if (Date.now() - new Date(m.created_at).getTime() > 2 * 60 * 1000) return { sent: 0, skipped: 0, removed: 0 };

  const k = await keys(token);
  const [profiles, subs] = await Promise.all([
    api(token, "/rest/v1/profiles?select=id,name"),
    api(token, "/rest/v1/push_subscriptions?select=endpoint,user_id,p256dh,auth,mode")
  ]);
  const names = {};
  profiles.forEach(function (p) { names[p.id] = p.name; });
  const sender = names[m.user_id] || "Someone";
  const body = preview(m);
  const options = { vapidDetails: { subject: SITE, publicKey: k.public_key, privateKey: k.private_key }, TTL: 3600, urgency: "high" };

  let sent = 0, skipped = 0, removed = 0;
  await Promise.all(subs.map(async function (s) {
    if (s.user_id === m.user_id) return;
    const name = names[s.user_id];
    const mentioned = !!name && new RegExp("@" + escapeRe(name) + "(?![\\w])", "i").test(m.body || "");
    if (s.mode === "mentions" && !mentioned) { skipped++; return; }
    const payload = JSON.stringify({
      title: mentioned ? sender + " mentioned you" : sender,
      body: body, url: "/?tab=chat", tag: "orbitus-chat"
    });
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, options);
      sent++;
    } catch (err) {
      // the phone or browser no longer has this subscription
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        removed++;
        await api(token, "/rest/v1/push_subscriptions?endpoint=eq." + encodeURIComponent(s.endpoint), { method: "DELETE" }).catch(function () {});
      } else skipped++;
    }
  }));
  return { sent: sent, skipped: skipped, removed: removed };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Sign in first." });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  try {
    if (body.action === "key") return res.status(200).json({ publicKey: (await keys(token)).public_key });
    if (body.action === "notify" && /^\d+$/.test(String(body.message_id))) return res.status(200).json(await notify(token, body.message_id));
    return res.status(400).json({ error: "Unknown action." });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    return res.status(status).json({ error: status === 500 ? "Could not send notifications." : err.message });
  }
};

module.exports.notify = notify;
module.exports.keys = keys;

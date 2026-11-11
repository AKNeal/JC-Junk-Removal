// /api/admin/login — team logins, password resets and the Team screen (same design as Black Wolf's inbox).
//   GET                         who am I? {user, needsSetup, emailReady}
//   GET ?reset=<token>          is this set-password link still good? {valid, name, email}
//   DELETE                      log out
//   POST {action:"login", email, password}         (blank email + shop key = owner, for setup and recovery)
//   POST {action:"forgot", email}                  emails a reset link (1 hour) when email is connected
//   POST {action:"reset", token, password}         sets a new password from a link, logs in
//   POST {action:"password", current, password}    change my own password
//   Owner / site admin only:
//   POST {action:"team"}
//   POST {action:"add", name, email, role, password?, mustChange?}   no password → returns a set-password link (72 hours)
//   POST {action:"setPassword", id, password, mustChange?}
//   POST {action:"update", id, name?, role?, active?}
//   POST {action:"remove", id}
//   POST {action:"resetLink", id}

const auth = require("../_lib/auth");
const store = require("../_lib/store");
const config = require("../_lib/config");
const { sendEmail, emailReady } = require("../_lib/email");
const { send, body, ip, id, str, baseUrl } = require("../_lib/http");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const INVITE_HOURS = 72, FORGOT_HOURS = 1;
const OWNER = config.site.ownerName;

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") return await get(req, res);
    if (req.method === "DELETE") { auth.clearSession(req, res); return send(res, 200, { ok: true }); }
    if (req.method !== "POST") { res.setHeader("Allow", "GET, POST, DELETE"); return send(res, 405, { error: "Method not allowed" }); }
    const b = body(req);
    switch (b.action || "login") {
      case "login": return await login(req, res, b);
      case "forgot": return await forgot(req, res, b);
      case "reset": return await reset(req, res, b);
      case "password": return await changeOwn(req, res, b);
      case "team": case "add": case "update": case "remove": case "resetLink": case "setPassword": return await team(req, res, b);
      default: return send(res, 400, { error: "Unknown action." });
    }
  } catch (e) {
    console.error("[login]", e);
    return send(res, 400, { error: e.message || "Something went wrong." });
  }
};

async function get(req, res) {
  const token = new URL(req.url, "http://x").searchParams.get("reset");
  if (token) {
    const t = await auth.takeReset(token, true);
    const u = t && (await auth.users()).find((x) => x.id === t.uid && x.active !== false);
    return send(res, 200, u ? { valid: true, name: u.name, email: u.email } : { valid: false });
  }
  const me = await auth.currentUser(req, { allowMustChange: true });
  return send(res, 200, {
    admin: Boolean(me), user: me ? { ...auth.publicUser(me), shopKey: me.id === "shop" } : null,
    needsSetup: (await auth.users()).length === 0, emailReady: emailReady(),
  });
}

async function login(req, res, b) {
  if ((await store.hit(`rl:login:${ip(req)}`, 900)) > 10) return send(res, 429, { error: "Too many attempts. Wait 15 minutes." });
  const email = str(b.email, 120).toLowerCase();
  const pw = typeof b.password === "string" ? b.password : "";
  if (!email) {
    if (!process.env.ADMIN_PASSWORD) return send(res, 500, { error: "ADMIN_PASSWORD isn't set in Vercel yet." });
    if (!auth.checkShopKey(pw)) return send(res, 401, { error: "Wrong email or password." });
    auth.setSession(req, res, { id: "shop", ver: 0 });
    return send(res, 200, { ok: true });
  }
  const list = await auth.users();
  const u = list.find((x) => x.email === email);
  const good = auth.verifyPassword(pw, u?.hash);
  if (!u || !good || u.active === false) return send(res, 401, { error: u && good ? `This login has been turned off. Ask ${OWNER}.` : "Wrong email or password." });
  u.lastLogin = new Date().toISOString();
  await auth.saveUsers(list);
  auth.setSession(req, res, u);
  return send(res, 200, { ok: true });
}

async function forgot(req, res, b) {
  if ((await store.hit(`rl:forgot:${ip(req)}`, 3600)) > 5) return send(res, 429, { error: `Too many tries. Wait an hour, or ask ${OWNER} for a reset link.` });
  const email = str(b.email, 120).toLowerCase();
  if (!EMAIL_RE.test(email)) return send(res, 400, { error: "Enter the email you log in with." });
  if (!emailReady()) return send(res, 200, { ok: true, emailed: false,
    message: `Email isn't connected to the site yet, so it can't send reset links. Ask ${OWNER} to make you one from the Team screen.` });
  const u = (await auth.users()).find((x) => x.email === email && x.active !== false);
  if (u) {
    const link = await auth.makeResetLink(baseUrl(req), u, FORGOT_HOURS);
    await sendEmail({ to: u.email, subject: `Reset your ${config.site.name} team password`, title: "Reset your password",
      paragraphs: [`Hi ${u.name.split(" ")[0]},`, "Use the button below to choose a new password. The link works once and expires in an hour.",
        "If you didn't ask for this, you can ignore this email; your password hasn't changed."], button: { label: "Choose a new password", url: link } });
  }
  // Same answer whether or not the email has a login, so this can't be used to find out who works here.
  return send(res, 200, { ok: true, emailed: true, message: "If that email has a login, a reset link is on its way. It expires in an hour." });
}

async function reset(req, res, b) {
  if ((await store.hit(`rl:reset:${ip(req)}`, 900)) > 20) return send(res, 429, { error: "Too many attempts. Wait 15 minutes." });
  const problem = auth.passwordProblem(b.password);
  if (problem) return send(res, 400, { error: problem });
  const t = await auth.takeReset(str(b.token, 100));
  if (!t) return send(res, 400, { error: "This link has expired or was already used. Ask for a new one." });
  const list = await auth.users();
  const u = list.find((x) => x.id === t.uid && x.active !== false);
  if (!u) return send(res, 400, { error: "This login no longer exists." });
  u.hash = auth.hashPassword(b.password); u.ver = (u.ver || 0) + 1; u.mustChange = false; u.lastLogin = new Date().toISOString();
  await auth.saveUsers(list);
  auth.setSession(req, res, u);
  return send(res, 200, { ok: true });
}

async function changeOwn(req, res, b) {
  const me = await auth.currentUser(req, { allowMustChange: true });
  if (!me) return send(res, 401, { error: "Log in first." });
  if (me.id === "shop") return send(res, 400, { error: "The shop key is changed in Vercel (ADMIN_PASSWORD), not here." });
  const list = await auth.users();
  const u = list.find((x) => x.id === me.id);
  if (!u.mustChange && !auth.verifyPassword(b.current, u.hash)) return send(res, 400, { error: "Your current password isn't right." });
  const problem = auth.passwordProblem(b.password);
  if (problem) return send(res, 400, { error: problem });
  if (u.mustChange && auth.verifyPassword(b.password, u.hash)) return send(res, 400, { error: "Pick a different password from the one you were given." });
  u.hash = auth.hashPassword(b.password); u.ver = (u.ver || 0) + 1; u.mustChange = false;
  await auth.saveUsers(list);
  auth.setSession(req, res, u); // stay logged in here; other devices are logged out
  return send(res, 200, { ok: true });
}

async function team(req, res, b) {
  const me = await auth.currentUser(req);
  if (!me) return send(res, 401, { error: "Log in first." });
  if (!auth.isFull(me)) return send(res, 403, { error: `Only ${OWNER} or the site admin can manage logins.` });
  const site = baseUrl(req);
  const list = await auth.users();
  const find = () => { const u = list.find((x) => x.id === str(b.id, 40)); if (!u) throw new Error("That person isn't on the team."); return u; };
  const fullLeft = (without) => list.some((x) => x.id !== without && auth.isFull(x) && x.active !== false);
  const checkRole = (role) => { if (!auth.ROLES[role]) throw new Error("Pick a role."); };
  async function inviteOut(u, hours, verb) {
    const link = await auth.makeResetLink(site, u, hours);
    let emailed = false;
    if (emailReady()) {
      const r = await sendEmail({ to: u.email, subject: `Your ${config.site.name} team login`, title: verb === "reset" ? "Reset your password" : "You've been added to the JC's team area",
        paragraphs: [`Hi ${u.name.split(" ")[0]},`, verb === "reset" ? "Here's a link to choose a new password for the team area." : `${me.name === "Shop key" ? OWNER : me.name} gave you a login for ${config.site.name}'s team area (estimates and more).`,
          `Your login email is ${u.email}. The link works once and expires in ${hours} hours.`], button: { label: "Choose a password", url: link } });
      emailed = Boolean(r.ok);
    }
    return { link, emailed, hours };
  }

  switch (b.action) {
    case "team": break;

    case "add": {
      const name = str(b.name, 60), email = str(b.email, 120).toLowerCase(), role = str(b.role, 10);
      if (name.length < 2) throw new Error("Enter their name.");
      if (!EMAIL_RE.test(email)) throw new Error("Enter a valid email. It's what they'll log in with.");
      if (list.some((x) => x.email === email)) throw new Error("Someone already logs in with that email.");
      checkRole(role);
      const pw = typeof b.password === "string" && b.password ? b.password : "";
      if (pw) { const problem = auth.passwordProblem(pw); if (problem) throw new Error(`Password: ${problem}`); }
      const u = { id: id(8), name, email, role, hash: pw ? auth.hashPassword(pw) : "", mustChange: Boolean(pw) && b.mustChange !== false,
        ver: 0, active: true, createdAt: new Date().toISOString(), createdBy: me.name };
      list.push(u); await auth.saveUsers(list);
      return send(res, 200, { ok: true, created: { id: u.id, withPassword: Boolean(pw) }, invite: pw ? null : await inviteOut(u, INVITE_HOURS, "add"), ...teamOut(list) });
    }

    case "update": {
      const u = find();
      if (b.name !== undefined) { const n = str(b.name, 60); if (n.length < 2) throw new Error("Enter their name."); u.name = n; }
      const role = b.role !== undefined ? str(b.role, 10) : u.role;
      if (u.id === me.id && (role !== u.role || b.active === false)) throw new Error("You can't change your own role or turn off your own login.");
      checkRole(role);
      if (auth.isFull(u) && (!["owner", "admin"].includes(role) || b.active === false) && !fullLeft(u.id))
        throw new Error("Keep at least one Owner or Site admin login.");
      const changedAccess = role !== u.role || (b.active !== undefined && Boolean(b.active) !== (u.active !== false));
      u.role = role;
      if (b.active !== undefined) u.active = Boolean(b.active);
      if (changedAccess) u.ver = (u.ver || 0) + 1; // log them out so the new access applies right away
      await auth.saveUsers(list);
      return send(res, 200, { ok: true, ...teamOut(list) });
    }

    case "remove": {
      const u = find();
      if (u.id === me.id) throw new Error("You can't remove your own login.");
      if (auth.isFull(u) && !fullLeft(u.id)) throw new Error("Keep at least one Owner or Site admin login.");
      const next = list.filter((x) => x.id !== u.id);
      await auth.saveUsers(next);
      return send(res, 200, { ok: true, ...teamOut(next) });
    }

    case "setPassword": {
      const u = find();
      if (u.id === me.id) throw new Error("Change your own password on the dashboard.");
      const problem = auth.passwordProblem(b.password);
      if (problem) throw new Error(`Password: ${problem}`);
      u.hash = auth.hashPassword(b.password); u.mustChange = b.mustChange !== false; u.ver = (u.ver || 0) + 1;
      await auth.saveUsers(list);
      return send(res, 200, { ok: true, ...teamOut(list) });
    }

    case "resetLink": {
      const u = find();
      return send(res, 200, { ok: true, invite: await inviteOut(u, INVITE_HOURS, "reset"), ...teamOut(list) });
    }
  }
  return send(res, 200, { ok: true, ...teamOut(list) });
}

function teamOut(list) {
  return { users: list.map(auth.publicUser), roles: auth.ROLES, emailReady: emailReady() };
}

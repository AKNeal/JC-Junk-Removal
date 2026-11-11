// Team logins — same system as the Black Wolf Tattoo Club inbox, trimmed for JC's.
// Everyone has their own account (email + password, stored as a scrypt hash) and a role:
//   owner, admin — everything, including the Team screen and prices
//   crew         — estimates only
// The shared ADMIN_PASSWORD still works as the "shop key" (blank email): it signs in as an owner, for first setup and
// for getting back in if every password is lost. Change it in Vercel once everyone has their own login.
// Sessions are a signed, HttpOnly cookie that carries the user's id and a version; changing or resetting a password
// bumps the version, which logs that person out everywhere.

const crypto = require("crypto");
const store = require("./store");

const COOKIE = "jc_admin";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days — crews sign in on their phones
const ROLES = { owner: "Owner", admin: "Site admin", crew: "Crew" };
const FULL = new Set(["owner", "admin"]);
const SHOP = { id: "shop", name: "Shop key", email: "", role: "owner", ver: 0 };

function secret() {
  const s = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!s) throw new Error("Set ADMIN_PASSWORD (and ideally SESSION_SECRET) in Vercel to use the team area.");
  return s;
}
const sign = (v) => crypto.createHmac("sha256", secret()).update(v).digest("base64url");
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
function safeEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

// ----- users -----
async function users() { return (await store.getJSON("users")) || []; }
async function saveUsers(list) { await store.setJSON("users", list); }
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, roleName: ROLES[u.role],
  active: u.active !== false, hasPassword: Boolean(u.hash), mustChange: Boolean(u.mustChange), createdAt: u.createdAt, lastLogin: u.lastLogin || null });

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString("base64url")}.${crypto.scryptSync(pw, salt, 32).toString("base64url")}`;
}
function verifyPassword(pw, stored) {
  if (!stored || typeof pw !== "string") { crypto.scryptSync("x", "y", 32); return false; } // same work either way
  const [salt, h] = stored.split(".");
  return safeEqual(crypto.scryptSync(pw, Buffer.from(salt, "base64url"), 32).toString("base64url"), h);
}
function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "That password is too long.";
  if (/^(.)\1+$/.test(pw) || /^(password|jcjunk|junk|12345)/i.test(pw)) return "Pick something harder to guess.";
  return null;
}
function checkShopKey(pw) {
  const real = process.env.ADMIN_PASSWORD;
  return Boolean(real) && typeof pw === "string" && crypto.timingSafeEqual(sha(pw), sha(real));
}

// ----- sessions -----
function isSecure(req) { return (req.headers["x-forwarded-proto"] || "").includes("https") || process.env.VERCEL === "1"; }
function setSession(req, res, u) {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE);
  const payload = `${u.id}.${u.ver || 0}.${exp}`;
  res.setHeader("Set-Cookie", `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}${isSecure(req) ? "; Secure" : ""}`);
}
function clearSession(req, res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure(req) ? "; Secure" : ""}`);
}
// The logged-in person, or null. Someone who must pick a new password first only gets through where allowMustChange is set.
async function currentUser(req, { allowMustChange = false } = {}) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 4) return null;
  const [uid, ver, exp, sig] = parts;
  try { if (!safeEqual(sig, sign(`${uid}.${ver}.${exp}`))) return null; } catch { return null; }
  if (Number(exp) <= Date.now() / 1000) return null;
  if (uid === "shop") return process.env.ADMIN_PASSWORD ? SHOP : null;
  const u = (await users()).find((x) => x.id === uid);
  if (!u || u.active === false || String(u.ver || 0) !== ver) return null;
  if (u.mustChange && !allowMustChange) return null;
  return u;
}

const isFull = (u) => FULL.has(u.role);

// ----- one-time links (invite / reset) -----
async function makeResetLink(site, u, hours) {
  const token = crypto.randomBytes(24).toString("base64url");
  await store.setJSON(`pwreset:${sha(token).toString("hex")}`, { uid: u.id, exp: Date.now() + hours * 3600e3 });
  return `${site}/admin/?reset=${token}`;
}
async function takeReset(token, peek = false) {
  if (typeof token !== "string" || token.length < 20 || token.length > 80) return null;
  const key = `pwreset:${sha(token).toString("hex")}`;
  const t = await store.getJSON(key);
  if (!t || t.exp < Date.now()) return null;
  if (!peek) await store.setJSON(key, { ...t, exp: 0 }); // one use
  return t;
}

module.exports = {
  ROLES, users, saveUsers, publicUser, hashPassword, verifyPassword, passwordProblem, checkShopKey,
  setSession, clearSession, currentUser, isFull, makeResetLink, takeReset,
};
